import { request, GraphQLClient } from 'graphql-request'

import stripe from '../lib/stripe'
import client from '../lib/client'

const FETCH_DATAHUB_URL = `
   query organizations($stripePaymentIntentId: String_comparison_exp!) {
      organizations: customerPaymentIntents(where: {stripePaymentIntentId: $stripePaymentIntentId}) {
         id
         org: organization {
            secret: adminSecret
            url: organizationUrl
         }
      }
   }
`

const UPDATE_CART = `
   mutation updateCart($id: Int_comparison_exp!, $paymentStatus: String!, $transactionRemark: jsonb!) {
      updateCart(
         where: {id: $id}, 
         _set: {paymentStatus: $paymentStatus, transactionRemark: $transactionRemark}) {
         returning {
            id
         }
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
      const { organizations } = await client.request(FETCH_DATAHUB_URL, {
         stripePaymentIntentId: {
            _eq: intent.id,
         },
      })

      if (organizations.length > 0) {
         const [organization] = organizations

         let url = `https://${organization.org.url}/datahub/v1/graphql`

         const datahubClient = new GraphQLClient(url, {
            headers: {
               'x-hasura-admin-secret': organization.org.secret,
            },
         })

         await datahubClient.request(UPDATE_CART, {
            transactionRemark: intent,
            id: { _eq: intent.transferGroup },
            paymentStatus: STATUS[intent.status],
         })

         return res.status(200).json({ received: true })
      } else {
         throw Error("Linked organization doesn't exists!")
      }
   } catch (error) {
      return res.status(404).json({ success: false, error: error.message })
   }
}
