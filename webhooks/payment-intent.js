import stripe from '../lib/stripe'

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
      switch (event.type) {
         case 'payment_intent.created': {
            const paymentIntent = event.data.object
            console.log(
               'paymentIntentEvents -> payment_intent.created',
               paymentIntent
            )
            break
         }
         case 'payment_intent.succeeded': {
            const paymentIntent = event.data.object
            console.log(
               'paymentIntentEvents -> payment_intent.succeeded',
               paymentIntent
            )
            break
         }
         case 'payment_intent.processing': {
            const paymentIntent = event.data.object
            console.log(
               'paymentIntentEvents -> payment_intent.processing',
               paymentIntent
            )
            break
         }
         case 'payment_intent.payment_failed': {
            const paymentIntent = event.data.object
            console.log(
               'paymentIntentEvents -> payment_intent.payment_failed',
               paymentIntent
            )
            break
         }
         case 'payment_intent.canceled': {
            const paymentIntent = event.data.object
            console.log(
               'paymentIntentEvents -> payment_intent.canceled',
               paymentIntent
            )
            break
         }
         default: {
            return res.status(400).end()
         }
      }
      return res.status(200).json({ received: true })
   } catch (error) {
      return res.status(404).json({ success: false, error: error.message })
   }
}
