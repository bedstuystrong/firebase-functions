
const functions = require('firebase-functions');
const { simpleParser } = require('mailparser');
const get = require('lodash/get');
const pick = require('lodash/pick');
const intersection = require('lodash/intersection');

const { sendgridMiddleware, extractPaymentDetails } = require('./email');

module.exports = {
  email: functions.https.onRequest((req, res) => {
    return sendgridMiddleware(req, res, async () => {
      const email = pick(req.body, ['to', 'headers', 'subject', 'text']);

      const parsed = await simpleParser(email.headers);
      const date = parsed.headers.get('date');
      const fromAddresses = parsed.headers.get('from').value.map(v => v.address);

      if (intersection(fromAddresses, [
        'ghostbaldwin@gmail.com',
        'iaredada@gmail.com',
        'fund@bedstuystrong.com'
      ]).length === 0) {
        // Do nothing
        return res.status(200).send('OK');
      }

      /* 
        TODO parse things
        have a parser(subject, html) for each service
      */
      const paymentPlatform = get(email.to.match(/^funds\+([a-z]+)@.+$/m, ''), 1);
      if (!paymentPlatform) {
        // todo error
        throw new Error(`invalid "to" email ${email.to}`);
      }

      const result = extractPaymentDetails(paymentPlatform, email);
      console.log({result}, {date})

      return res.status(200).send('OK');
    });
  }),
};