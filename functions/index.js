const functions = require('firebase-functions');

const { parsePhoneNumberFromString } = require('libphonenumber-js');

const { createEmptyTwimlResponse } = require('./twilio');
const { getPhoneNumberId, createMessage } = require('./airtable');

exports.intake = {
  sms: functions.https.onRequest(async (req, res) => {
    const fromNumber = parsePhoneNumberFromString(req.query.From).formatNational();
    const messageBody = req.query.Body;

    const phoneNumberId = await getPhoneNumberId(fromNumber);
    
    await createMessage(phoneNumberId, messageBody);

    res.set('Content-Type', 'text/xml');
    res.send(createEmptyTwimlResponse());
  }),
};
