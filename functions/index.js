const functions = require('firebase-functions');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

const {
  webhookMiddleware,
  createEmptyMessageResponse,
  createEmptyVoiceResponse,
  createVoicemailRecordingPrompt,
} = require('./twilio');
const {
  getPhoneNumberId,
  createMessage,
  createVoicemail,
} = require('./airtable');

exports.intake = {

  sms: functions.https.onRequest((req, res) => {
    return webhookMiddleware(req, res, async () => {
      const fromNumber = parsePhoneNumberFromString(req.body.From).formatNational();
      const messageBody = req.body.Body;

      const phoneNumberId = await getPhoneNumberId(fromNumber);

      await createMessage(phoneNumberId, messageBody);

      res.set('Content-Type', 'text/xml');
      res.send(createEmptyMessageResponse());
    });
  }),

  voice: functions.https.onRequest((req, res) => {
    return webhookMiddleware(req, res, () => {
      res.set('Content-Type', 'text/xml');
      res.send(createVoicemailRecordingPrompt());
    });
  }),

  voicemail: functions.https.onRequest((req, res) => {
    return webhookMiddleware(req, res, async () => {
      const fromNumber = parsePhoneNumberFromString(req.body.From).formatNational();
      const recordingUrl = `${req.body.RecordingUrl}.mp3`;
      const transcription = req.body.TranscriptionText;

      const phoneNumberId = await getPhoneNumberId(fromNumber);

      await createVoicemail(phoneNumberId, recordingUrl, transcription);

      res.set('Content-Type', 'text/xml');
      res.send(createEmptyVoiceResponse());
    });
  }),

  empty: functions.https.onRequest((req, res) => {
    return webhookMiddleware(req, res, () => {
      res.set('Content-Type', 'text/xml');
      res.send(createEmptyVoiceResponse());
    });
  }),

};
