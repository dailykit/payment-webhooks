import { GraphQLClient } from 'graphql-request'

import stripe from '../lib/stripe'
import client from '../lib/client'

const UPDATE_CUSTOMER_PAYMENT_INTENT = `
   mutation updateCustomerPaymentIntent(
      $id: uuid!
      $_set: stripe_customerPaymentIntent_set_input = {}
      $_inc: stripe_customerPaymentIntent_inc_input = {}
   ) {
      updateCustomerPaymentIntent(
         pk_columns: { id: $id }
         _set: $_set
         _inc: $_inc
      ) {
         id
      }
   }
`

const FETCH_DATAHUB_URL = `
   query customerPaymentIntents(
      $where: stripe_customerPaymentIntent_bool_exp!
   ) {
      customerPaymentIntents(where: $where) {
         id
         transferGroup
         organization {
            stripeAccountId
            secret: adminSecret
            url: organizationUrl
         }
      }
   }
`

const UPDATE_CART = `
   mutation updateCart(
      $pk_columns: order_cart_pk_columns_input!
      $_set: order_cart_set_input = {}
   ) {
      updateCart(pk_columns: $pk_columns, _set: $_set) {
         id
      }
   }
`

const DAILYCLOAK_INSERT_STRIPE_PAYMENT_HISTORY = `
   mutation insertStripePaymentHistory(
      $objects: [stripe_stripePaymentHistory_insert_input!]!
   ) {
      insertStripePaymentHistory: insert_stripe_stripePaymentHistory(
         objects: $objects
      ) {
         affected_rows
      }
   }
`

const DATAHUB_INSERT_STRIPE_PAYMENT_HISTORY = `
   mutation insertStripePaymentHistory(
      $objects: [order_stripePaymentHistory_insert_input!]!
   ) {
      insertStripePaymentHistory: insert_order_stripePaymentHistory(
         objects: $objects
      ) {
         affected_rows
      }
   }
`

const STATUS = {
   created: 'CREATED',
   canceled: 'CANCELLED',
   succeeded: 'SUCCEEDED',
   processing: 'PROCESSING',
   payment_failed: 'PAYMENT_FAILED',
   requires_action: 'REQUIRES_ACTION',
   requires_payment_method: 'REQUIRES_PAYMENT_METHOD',
}

export const paymentIntentEvents = async (req, res) => {
   try {
      const signature = req.headers['stripe-signature']
      let event

      let SECRET = process.env.WEBHOOK_STRIPE_SECRET

      const body = JSON.parse(req.rawBody)
      if ('account' in body && body.account) {
         SECRET = process.env.WEBHOOK_STRIPE_CONNECT_SECRET
      }

      try {
         event = await stripe.webhooks.constructEvent(
            req.rawBody,
            signature,
            SECRET
         )
      } catch (err) {
         return res.status(400).send({
            success: false,
            error: `Webhook Error: ${err.message}`,
         })
      }

      const node = event.data.object
      console.log('node -> object', {
         event: event.type,
         type: node.object,
         id: node.id,
      })
      if (!['invoice', 'payment_intent'].includes(node.object))
         return res.status(200).send({
            success: false,
            error: `No such event has been mapped yet!`,
         })

      const { customerPaymentIntents = [] } = await client.request(
         FETCH_DATAHUB_URL,
         {
            where: {
               ...(node.object === 'invoice' && {
                  stripeInvoiceId: { _eq: node.id },
               }),
               ...(node.object === 'payment_intent' && {
                  stripePaymentIntentId: { _eq: node.id },
               }),
            },
         }
      )

      if (customerPaymentIntents.length === 0)
         return res.status(200).send({
            success: false,
            error: `Not linked to any customer payment intent`,
         })

      const [customerPaymentIntent] = customerPaymentIntents
      const { organization = {} } = customerPaymentIntent
      let url = `https://${organization.url}/datahub/v1/graphql`

      const datahub = new GraphQLClient(url, {
         headers: {
            'x-hasura-admin-secret': organization.secret,
         },
      })

      if (node.object === 'invoice') {
         await handleInvoice({
            datahub,
            organization,
            eventType: event.type,
            invoice: event.data.object,
            recordId: customerPaymentIntent.id,
            cartId: customerPaymentIntent.transferGroup,
         })
         return res.status(200).json({ received: true })
      } else if (node.object === 'payment_intent') {
         await handlePaymentIntent({
            datahub,
            intent: event.data.object,
            recordId: customerPaymentIntent.id,
            cartId: customerPaymentIntent.transferGroup,
         })
         return res.status(200).json({ received: true })
      }
   } catch (error) {
      console.log(error)
      return res.status(500).json({ success: false, error: error.message })
   }
}

const handleInvoice = async ({
   recordId,
   cartId,
   invoice,
   organization,
   datahub,
   eventType,
}) => {
   try {
      let payment_intent = null
      if (invoice.payment_intent) {
         payment_intent = await stripe.paymentIntents.retrieve(
            invoice.payment_intent,
            { stripeAccount: organization.stripeAccountId }
         )
         // SEND ACTION REQUIRED SMS
         if (eventType === 'invoice.payment_action_required') {
            console.log('SEND ACTION URL SMS')
            await client.request(UPDATE_CUSTOMER_PAYMENT_INTENT, {
               id: recordId,
               _inc: { smsAttempt: 1 },
               _set: {
                  stripeInvoiceId: invoice.id,
                  stripeInvoiceDetails: invoice,
                  ...(payment_intent && {
                     transactionRemark: payment_intent,
                     stripePaymentIntentId: payment_intent.id,
                     status: STATUS[payment_intent.status],
                  }),
               },
            })
         }
         if (
            invoice.payment_settings.payment_method_options === null &&
            eventType === 'invoice.payment_failed'
         ) {
            const wasPreviousIntentDeclined =
               payment_intent &&
               payment_intent.last_payment_error &&
               Object.keys(payment_intent.last_payment_error).length > 0 &&
               payment_intent.last_payment_error.code === 'card_declined' &&
               ['do_not_honor', 'transaction_not_allowed'].includes(
                  payment_intent.last_payment_error.decline_code
               )
            if (wasPreviousIntentDeclined) {
               console.log('INCREMENT PAYMENT ATTEMPT DUE CARD DO NOT HONOR')
               await client.request(UPDATE_CUSTOMER_PAYMENT_INTENT, {
                  id: recordId,
                  _inc: { paymentRetryAttempt: 1 },
                  _set: { requires3dSecure: true },
               })
               return
            }
         }
      }

      await client.request(UPDATE_CUSTOMER_PAYMENT_INTENT, {
         id: recordId,
         _set: {
            stripeInvoiceId: invoice.id,
            stripeInvoiceDetails: invoice,
            ...(payment_intent && {
               transactionRemark: payment_intent,
               stripePaymentIntentId: payment_intent.id,
               status: STATUS[payment_intent.status],
            }),
         },
      })

      let dailycloak_history_objects = [
         {
            type: 'INVOICE',
            status: invoice.status,
            stripeInvoiceId: invoice.id,
            stripeInvoiceDetails: invoice,
            customerPaymentIntentId: recordId,
         },
      ]

      if (payment_intent) {
         dailycloak_history_objects.push({
            type: 'PAYMENT_INTENT',
            status: payment_intent.status,
            customerPaymentIntentId: recordId,
            transactionRemark: payment_intent,
            stripePaymentIntentId: payment_intent.id,
         })
      }

      await client.request(DAILYCLOAK_INSERT_STRIPE_PAYMENT_HISTORY, {
         objects: dailycloak_history_objects,
      })

      await datahub.request(UPDATE_CART, {
         pk_columns: { id: cartId },
         _set: {
            stripeInvoiceId: invoice.id,
            stripeInvoiceDetails: invoice,
            ...(payment_intent && {
               transactionRemark: payment_intent,
               transactionId: payment_intent.id,
               paymentStatus: STATUS[payment_intent.status],
            }),
         },
      })

      let datahub_history_objects = [
         {
            cartId,
            type: 'INVOICE',
            status: invoice.status,
            stripeInvoiceId: invoice.id,
            stripeInvoiceDetails: invoice,
         },
      ]

      if (payment_intent) {
         datahub_history_objects.push({
            cartId,
            type: 'PAYMENT_INTENT',
            status: payment_intent.status,
            transactionId: payment_intent.id,
            transactionRemark: payment_intent,
         })
      }

      await datahub.request(DATAHUB_INSERT_STRIPE_PAYMENT_HISTORY, {
         objects: datahub_history_objects,
      })

      return
   } catch (error) {
      throw error
   }
}

const handlePaymentIntent = async ({ recordId, cartId, intent, datahub }) => {
   try {
      await client.request(UPDATE_CUSTOMER_PAYMENT_INTENT, {
         id: recordId,
         _set: {
            transactionRemark: intent,
            status: STATUS[intent.status],
            stripePaymentIntentId: intent.id,
         },
      })

      await client.request(DAILYCLOAK_INSERT_STRIPE_PAYMENT_HISTORY, {
         objects: [
            {
               type: 'PAYMENT_INTENT',
               status: intent.status,
               transactionRemark: intent,
               stripePaymentIntentId: intent.id,
               customerPaymentIntentId: recordId,
            },
         ],
      })

      await datahub.request(UPDATE_CART, {
         pk_columns: { id: cartId },
         _set: {
            transactionId: intent.id,
            transactionRemark: intent,
            paymentStatus: STATUS[intent.status],
         },
      })

      await datahub.request(DATAHUB_INSERT_STRIPE_PAYMENT_HISTORY, {
         objects: [
            {
               cartId,
               status: intent.status,
               type: 'PAYMENT_INTENT',
               transactionId: intent.id,
               transactionRemark: intent,
            },
         ],
      })
      return
   } catch (error) {
      throw error
   }
}
