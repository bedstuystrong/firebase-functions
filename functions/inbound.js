const functions = require('firebase-functions');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const _ = require('lodash');

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
  INTAKE_TABLE,
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

      await createVoicemail(fromNumber, recordingUrl, '');

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
    const tableKey = req.query.table;
    const volunteerKey = req.query.volunteer;
    const recordID = req.query.record;

    const table = _.get({
      inbound: INBOUND_TABLE,
      intake: INTAKE_TABLE,
    }, tableKey);
    if (!table) {
      res.status(400).send(`Unsupported table ${tableKey}`);
    }

    const volunteerFieldName = _.get({
      intake: 'intakeVolunteer',
      delivery: 'deliveryVolunteer',
      bulk: 'bulkCallbackVolunteer',
    }, volunteerKey);
    if (!volunteerFieldName) {
      res.status(400).send(`Missing volunteer field associated with key "${volunteerKey}"`);
    }

    const [, recordFields,] = await getRecord(table, recordID);
    if (!recordFields[volunteerFieldName]) {
      res.status(400).send(`No ${volunteerKey} volunteer associated with record ${recordID} on table "${table}"`);
    }

    const [, volunteerFields,] = await getRecord(VOLUNTEER_FORM_TABLE, recordFields[volunteerFieldName]);
    
    const recordPhoneNumber = parsePhoneNumberFromString(recordFields.phoneNumber, 'US').format('E.164');
    const volunteerPhoneNumber = parsePhoneNumberFromString(volunteerFields.phoneNumber, 'US').format('E.164');

    if (!recordPhoneNumber || !volunteerPhoneNumber) {
      console.error('Missing a phone number', {
        recordPhoneNumber,
        volunteerPhoneNumber,
      });
    }

    await requestConnectCall(volunteerPhoneNumber, recordPhoneNumber);

    res.status(200).send(`Hi ${volunteerFields.name}! You'll get a call from Bed-Stuy Strong shortly connecting you to ${recordPhoneNumber}`);
  }),

};
