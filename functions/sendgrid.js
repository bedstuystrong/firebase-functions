const Busboy = require('busboy');

const sendgridMiddleware = (req, res, next) => {
  const busboy = new Busboy({ headers: req.headers });

  busboy.on('field', (fieldname, value) => {
    req.body[fieldname] = value;
  });

  busboy.on('finish', () => {
    next();
  });

  busboy.end(req.rawBody);
};

module.exports = {
  sendgridMiddleware: sendgridMiddleware,
};