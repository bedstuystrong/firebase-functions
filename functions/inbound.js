const functions = require('firebase-functions');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

const {
  middleware,
  createEmptyMessageResponse,
  createEmptyVoiceResponse,
  createVoicemailRecordingPrompt,
  requestConnectCall,
} = require('./twilio');
const {
  createMessage,
  createVoicemail,
  getRecord,
  INBOUND_TABLE,
  VOLUNTEER_FORM_TABLE,
} = require('./airtable');


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

  callback: functions.https.onRequest(async (req, res) => {
    const inboundRecordID = req.query.record;

    const [, inboundFields,] = await getRecord(INBOUND_TABLE, inboundRecordID);
    if (!inboundFields.intakeVolunteer) {
      res.status(400).send(`No volunteer associated with record ${inboundRecordID}`);
    }

    const [, volunteerFields,] = await getRecord(VOLUNTEER_FORM_TABLE, inboundFields.intakeVolunteer);
    
    const inboundPhoneNumber = parsePhoneNumberFromString(inboundFields.phoneNumber, 'US').format('E.164');
    const volunteerPhoneNumber = parsePhoneNumberFromString(volunteerFields.phoneNumber, 'US').format('E.164');

    if (!inboundPhoneNumber || !volunteerPhoneNumber) {
      console.error('Missing a phone number', {
        inboundPhoneNumber,
        volunteerPhoneNumber,
      });
    }

    await requestConnectCall(volunteerPhoneNumber, inboundPhoneNumber);

    res.status(200).send(`You'll get a call from Bed-Stuy Strong shortly connecting you to ${inboundFields.phoneNumber}`);
  }),

};
