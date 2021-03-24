import { request, GraphQLClient } from 'graphql-request'

import stripe from '../lib/stripe'
import client from '../lib/client'

const UPDATE_CUSTOMER_PAYMENT_INTENT = `
   mutation updateCustomerPaymentIntent($id: uuid!, $_set: stripe_customerPaymentIntent_set_input!) {
      updateCustomerPaymentIntent(
         pk_columns: {id: $id}, 
         _set:  $_set
      ) {
         id
      }
   }
`

const FETCH_DATAHUB_URL = `
   query customerPaymentIntents(
      $stripePaymentIntentId: String_comparison_exp!
   ) {
      customerPaymentIntents(
         where: { stripePaymentIntentId: $stripePaymentIntentId }
      ) {
         id
         stripeAccountType
         organization {
            secret: adminSecret
            url: organizationUrl
         }
      }
   }
`

const UPDATE_CART = `
   mutation updateCart(
      $pk_columns: order_cart_pk_columns_input!
      $_set: order_cart_set_input!
   ) {
      updateCart(pk_columns: $pk_columns, _set: $_set) {
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
      try {
         event = await stripe.webhooks.constructEvent(
            req.rawBody,
            signature,
            process.env.WEBHOOK_PAYMENT_INTENT_SECRET
         )
      } catch (err) {
         return res.status(400).send({
            success: false,
            error: `Webhook Error: ${err.message}`,
         })
      }

      const intent = event.data.object
      const {
         customerPaymentIntents = [],
      } = await client.request(FETCH_DATAHUB_URL, {
         stripePaymentIntentId: { _eq: intent.id },
      })

      if (customerPaymentIntents.length > 0) {
         const [customerPaymentIntent] = customerPaymentIntents

         let invoice = null
         if (intent.invoice) {
            invoice = await stripe.invoices.retrieve(intent.invoice)
         }

         let url = `https://${organization.org.url}/datahub/v1/graphql`

         const datahub = new GraphQLClient(url, {
            headers: {
               'x-hasura-admin-secret':
                  customerPaymentIntent.organization.secret,
            },
         })

         await client.request(UPDATE_CUSTOMER_PAYMENT_INTENT, {
            id: customerPaymentIntent.id,
            _set: {
               transactionRemark: intent,
               status: STATUS[intent.status],
               stripePaymentIntentId: intent.id,
               ...(invoice && {
                  stripeInvoiceId: invoice.id,
                  stripeInvoiceDetails: invoice,
               }),
            },
         })

         await datahub.request(UPDATE_CART, {
            pk_columns: { id: intent.transferGroup },
            _set: {
               transactionId: intent.id,
               transactionRemark: intent,
               paymentStatus: STATUS[intent.status],
               ...(invoice && {
                  stripeInvoiceId: invoice.id,
                  stripeInvoiceDetails: invoice,
               }),
            },
         })

         return res.status(200).json({ received: true })
      } else {
         throw Error("Linked organization doesn't exists!")
      }
   } catch (error) {
      return res.status(404).json({ success: false, error: error.message })
   }
}
