
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
      const parsed = await simpleParser(email.headers);
      const date = parsed.headers.get('date');
      email.to = flow(
        get('value'),
        map(v => v.address),
        first,
      )(parsed.headers.get('to'));

      if (email.to.split('@')[0] !== 'funds' && email.to !== 'fund@bedstuystrong.com') {
        // Log and do nothing
        console.warn('Received email for user other than funds@', email);
        return res.status(200).send('OK');
      }

      const IS_AUTO_FORWARDED = email.to === 'fund@bedstuystrong.com';

      if (IS_AUTO_FORWARDED) {
        console.log({ text: email.text })
      }

      email.from = flow(
        get('value'),
        map(v => v.address),
        first,
      )(parsed.headers.get('from'));
      const fromKey = email.from.replace(/[@.]/g, '_');
      const accountHolder = functions.config().finance.emails[fromKey];

      if (!IS_AUTO_FORWARDED && !Object.keys(functions.config().finance.emails).includes(fromKey)) {
        // Log and do nothing
        console.warn('Received email from unauthorized forwarder', email);
        return res.status(200).send('OK');
      }
      
      const paymentPlatform = detectPaymentPlatform(email, { isAutoForwarded: IS_AUTO_FORWARDED });
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