function parse(req, res, next) {
   req.setEncoding('utf8')

   let data = ''

   req.on('data', function (chunk) {
      data += chunk
   })

   req.on('end', function () {
      req.rawBody = data

      next()
   })
}

export { parse }
