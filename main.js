import express from 'express'
import cors from 'cors'
import morgan from 'morgan'

import { parse } from './utils'
import { paymentIntentEvents } from './webhooks'

const app = express()

app.use(cors())
app.use(
   morgan(
      '[:status :method :url] :remote-user [:date[clf]] - [:user-agent] - :response-time ms'
   )
)

app.post('/api/webhook/payment-intent', parse, paymentIntentEvents)

app.listen(process.env.PORT, function () {
   console.log(`Listening on :${process.env.PORT}`)
})
