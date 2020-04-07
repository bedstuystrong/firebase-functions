
const functions = require('firebase-functions');


const { sendgridMiddleware } = require('./email');

module.exports = {
  email: functions.https.onRequest((req, res) => {
    return sendgridMiddleware(req, res, () => {
      const APPROVED_FORWARDERS = ['ghostbaldwin@gmail.com', 'fund@bedstuystrong.com'];
      const { from, headers, subject, html } = req.body;
      if (!APPROVED_FORWARDERS.includes(from)) {
        // Do nothing
        return res.status(200).send('OK');
      }

      console.log({ headers, subject, html })
      /* 
        TODO parse things
        have a parser(subject, html) for each service
      */
      return res.status(200).send('OK');
    });
  }),
};