const functions = require('firebase-functions');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const _ = require('lodash');

const {
  middleware,
  createEmptyMessageResponse,
  createEmptyVoiceResponse,
  createVoicemailRecordingPrompt,
  requestConnectCall,
  middlewareByProject,
  vaxSupportRequestConnectCall,
} = require('./twilio');
const {
  createMessage,
  createVoicemail,
  createVaxSupportMessage,
  createVaxSupportVoicemail,
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

  vaxSupportSms: functions.https.onRequest((req, res) => {
    const token = functions.config().twilio.vax_support.auth_token;
    return middlewareByProject(token, req, res, async () => {
      const fromNumber = parsePhoneNumberFromString(req.body.From).formatNational();
      const messageBody = req.body.Body;

      await createVaxSupportMessage(fromNumber, messageBody);

      res.set('Content-Type', 'text/xml');
      res.send(createEmptyMessageResponse());
    });
  }),

  /** DEPRECATED */
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

  vaxSupportVoicemail: functions.https.onRequest((req, res) => {
    const token = functions.config().twilio.vax_support.auth_token;
    return middlewareByProject(token, req, res, async () => {
      const fromNumber = parsePhoneNumberFromString(req.body.From).formatNational();
      const recordingUrl = req.body.RecordingUrl ? `${req.body.RecordingUrl}.mp3` : '';

      await createVaxSupportVoicemail(fromNumber, recordingUrl, '');

      res.set('Content-Type', 'text/xml');
      res.send(createEmptyVoiceResponse());
    });
  }),

  /** DEPRECATED */
  empty: functions.https.onRequest((req, res) => {
    return middleware(req, res, () => {
      res.set('Content-Type', 'text/xml');
      res.send(createEmptyVoiceResponse());
    });
  }),

  callback: functions.https.onRequest(async (req, res) => {
    const tableKey = req.query.table;
    const recordID = req.query.record;
    const volunteerID = req.query.volunteer;

    if (!(tableKey && recordID && volunteerID)) {
      res.status(400).send('Missing required query params');
      return;
    }

    const table = _.get({
      inbound: INBOUND_TABLE,
      intake: INTAKE_TABLE,
    }, tableKey);
    if (!table) {
      res.status(400).send(`Unsupported table ${tableKey}`);
      return;
    }

    const [, recordFields,] = await getRecord(table, recordID);
    const [, volunteerFields,] = await getRecord(VOLUNTEER_FORM_TABLE, volunteerID);

    const recordPhoneNumber = parsePhoneNumberFromString(recordFields.phoneNumber, 'US').format('E.164');
    const volunteerPhoneNumber = parsePhoneNumberFromString(volunteerFields.phoneNumber, 'US').format('E.164');

    if (!recordPhoneNumber || !volunteerPhoneNumber) {
      console.error('Missing a phone number', {
        recordPhoneNumber,
        volunteerPhoneNumber,
      });
      res.status(500).send('Missing a phone number on one or more records');
      return;
    }

    await requestConnectCall(volunteerPhoneNumber, recordPhoneNumber);

    res.status(200).send(`You'll get a call at ${volunteerFields.phoneNumber} from Bed-Stuy Strong shortly connecting you to ${recordFields.phoneNumber}`);
  }),

  vaxSupportCallback: functions.https.onRequest(async (req, res) => {
    const volunteerPhoneNumberRaw = req.query.volunteerPhoneNumber;
    const neighborPhoneNumberRaw = req.query.neighborPhoneNumber;
    const baseId = req.query.baseId;

    if (!(volunteerPhoneNumberRaw && neighborPhoneNumberRaw && baseId)) {
      res.status(400).send('Missing required query params');
      return;
    }

    if (baseId !== functions.config().airtable.vax_support_base_id) {
      res.status(500).send('Incorrect callback base');
      return;
    }

    const volunteerPhoneNumber = parsePhoneNumberFromString(volunteerPhoneNumberRaw, 'US').format('E.164');
    const neighborPhoneNumber = parsePhoneNumberFromString(neighborPhoneNumberRaw, 'US').format('E.164');

    if (!neighborPhoneNumber || !volunteerPhoneNumber) {
      console.error('Missing a phone number', {
        neighborPhoneNumber,
        volunteerPhoneNumber,
      });
      res.status(500).send('Missing a phone number on one or more records');
      return;
    }

    await vaxSupportRequestConnectCall(volunteerPhoneNumber, neighborPhoneNumber);

    res.status(200).send(`You'll get a call at ${volunteerPhoneNumber} from Bed-Stuy Strong shortly connecting you to ${neighborPhoneNumber}`);
  }),

};
