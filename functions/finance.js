
const functions = require('firebase-functions');
const { simpleParser } = require('mailparser');
const pick = require('lodash/pick');
const { flow, get, map, first, replace } = require('lodash/fp');

const { sendgridMiddleware, detectPaymentPlatform, extractPaymentDetails } = require('./email');
const { createFinanceTransaction } = require('./airtable');

module.exports = {
  email: functions.https.onRequest((req, res) => {
    return sendgridMiddleware(req, res, async () => {
      const email = pick(req.body, ['to', 'from', 'headers', 'subject', 'text']);

      if (email.to.split('@')[0] !== 'funds') {
        // Log and do nothing
        console.warning('Received email for user other than funds@', email);
        return res.status(200).send('OK');
      }

      const parsed = await simpleParser(email.headers);
      const date = parsed.headers.get('date');
      const fromAddress = flow(
        get('value'),
        map(v => v.address),
        first,
        replace(/[@.]/g, '_')
      )(parsed.headers.get('from'));
      const accountHolder = functions.config().finance.emails[fromAddress];

      if (!Object.keys(functions.config().finance.emails).includes(fromAddress)) {
        // Log and do nothing
        console.warning('Received email from unauthorized forwarder', email);
        return res.status(200).send('OK');
      }

      const paymentPlatform = detectPaymentPlatform(email.text);
      if (!paymentPlatform) {
        // todo error
        console.error(email);
        throw new Error('Couldn\'t detect payment platform');
      }

      const details = extractPaymentDetails(paymentPlatform, email);

      await createFinanceTransaction(Object.assign(details, { date, accountHolder }));

      return res.status(200).send('OK');
    });
  }),
};