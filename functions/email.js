const functions = require('firebase-functions');
const { simpleParser } = require('mailparser');
const sendgridMail = require('@sendgrid/mail');
const { flow, get, map, first } = require('lodash/fp');

const { sendgridMiddleware } = require('./sendgrid');

sendgridMail.setApiKey(functions.config().sendgrid.api_key);

module.exports = {
  forward: functions.https.onRequest((req, res) => {
    return sendgridMiddleware(req, res, async () => {
      // TODO port to python and add attachments
      const email = req.body;
      const fromDomain = functions.config().sendgrid.from_domain;
      const parsed = await simpleParser(email.headers);
      email.to = flow(
        get('value'),
        map(v => v.address),
        first,
      )(parsed.headers.get('to'));

      const split = email.to.split('@');
      const fromName = email.from.split('<')[0];

      if (split[1] !== fromDomain) {
        console.warn('Received email for domain other than ours', email);
        return res.status(401).send('Unauthorized');
      }

      await sendgridMail.send({
        from: `${fromName} <forwarded-email@${fromDomain}>`,
        to: `${split[0]}@bedstuystrong.com`,
        replyTo: email.from,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });

      return res.sendStatus(200);
    });
  }),
};