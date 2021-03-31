import { GraphQLClient } from 'graphql-request'

import stripe from '../lib/stripe'
import client from '../lib/client'

const UPDATE_CUSTOMER_PAYMENT_INTENT = `
   mutation updateCustomerPaymentIntent(
      $id: uuid!
      $_set: stripe_customerPaymentIntent_set_input = {}
      $_prepend: stripe_customerPaymentIntent_prepend_input = {}
   ) {
      updateCustomerPaymentIntent(
         pk_columns: { id: $id }
         _set: $_set
         _prepend: $_prepend
      ) {
         id
         stripeInvoiceHistory
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
      $_prepend: order_cart_prepend_input = {}
   ) {
      updateCart(pk_columns: $pk_columns, _set: $_set, _prepend: $_prepend) {
         id
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
}) => {
   try {
      let payment_intent = null
      if (invoice.payment_intent) {
         payment_intent = await stripe.paymentIntents.retrieve(
            invoice.payment_intent,
            { stripeAccount: organization.stripeAccountId }
         )
      }

      const { lines: invoiceLines = {}, ...invoiceRest } = invoice
      const { lines: intentLines = {}, ...intentRest } = payment_intent || {}
      await client.request(UPDATE_CUSTOMER_PAYMENT_INTENT, {
         id: recordId,
         _prepend: {
            stripeInvoiceHistory: invoiceRest,
            ...(payment_intent && {
               transactionRemarkHistory: intentRest,
            }),
         },
         _set: {
            stripeInvoiceId: invoice.id,
            stripeInvoiceDetails: invoiceRest,
            ...(payment_intent && {
               transactionRemark: intentRest,
               status: STATUS[payment_intent.status],
            }),
         },
      })

      await datahub.request(UPDATE_CART, {
         pk_columns: { id: cartId },
         _prepend: {
            stripeInvoiceHistory: invoiceRest,
            ...(payment_intent && {
               transactionRemarkHistory: intentRest,
            }),
         },
         _set: {
            stripeInvoiceId: invoice.id,
            stripeInvoiceDetails: invoiceRest,
            ...(payment_intent && {
               transactionId: payment_intent.id,
               transactionRemark: intentRest,
               paymentStatus: STATUS[payment_intent.status],
            }),
         },
      })
      return
   } catch (error) {
      throw error
   }
}

const handlePaymentIntent = async ({ recordId, cartId, intent, datahub }) => {
   try {
      const { lines: intentLines = {}, ...intentRest } = intent
      await client.request(UPDATE_CUSTOMER_PAYMENT_INTENT, {
         id: recordId,
         _prepend: { transactionRemarkHistory: intentRest },
         _set: {
            transactionRemark: intentRest,
            status: STATUS[intent.status],
         },
      })

      await datahub.request(UPDATE_CART, {
         pk_columns: { id: cartId },
         _prepend: { transactionRemarkHistory: intentRest },
         _set: {
            transactionId: intent.id,
            transactionRemark: intentRest,
            paymentStatus: STATUS[intent.status],
         },
      })
      return
   } catch (error) {
      throw error
   }
}
