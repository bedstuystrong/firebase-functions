const functions = require('firebase-functions');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const Busboy = require('busboy');

const {
  middleware,
  createEmptyMessageResponse,
  createEmptyVoiceResponse,
  createVoicemailRecordingPrompt,
} = require('./twilio');
const {
  createMessage,
  createVoicemail,
} = require('./airtable');


const multipartMiddleware = (req, res, next) => {
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

  sms: functions.https.onRequest((req, res) => {
    return middleware(req, res, async () => {
      const fromNumber = parsePhoneNumberFromString(req.body.From).formatNational();
      const messageBody = req.body.Body;

      await createMessage(fromNumber, messageBody);

      res.set('Content-Type', 'text/xml');
      res.send(createEmptyMessageResponse());
    });
  }),

  voice: functions.https.onRequest((req, res) => {
    return middleware(req, res, () => {
      res.set('Content-Type', 'text/xml');
      res.send(createVoicemailRecordingPrompt());
    });
  }),

  voicemail: functions.https.onRequest((req, res) => {
    return middleware(req, res, async () => {
      const fromNumber = parsePhoneNumberFromString(req.body.From).formatNational();
      const recordingUrl = `${req.body.RecordingUrl}.mp3`;
      const transcription = req.body.TranscriptionText;

      await createVoicemail(fromNumber, recordingUrl, transcription);

      res.set('Content-Type', 'text/xml');
      res.send(createEmptyVoiceResponse());
    });
  }),

  empty: functions.https.onRequest((req, res) => {
    return middleware(req, res, () => {
      res.set('Content-Type', 'text/xml');
      res.send(createEmptyVoiceResponse());
    });
  }),

  email: functions.https.onRequest((req, res) => {
    return multipartMiddleware(req, res, () => {
      // const { from, subject, html } = req.body;
      /* 
        TODO parse those ⬆️ !!!
        like switch (from) and then have a parser(subject, html) for each service
      */
      res.status(200).send('OK');
    });
  }),

};

