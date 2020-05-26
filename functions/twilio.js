const functions = require('firebase-functions');
const twilio = require('twilio');
const URL = require('url');

const { MessagingResponse, VoiceResponse } = twilio.twiml;

const client = twilio(functions.config().twilio.sid, functions.config().twilio.auth_token);

module.exports = {

  /**
   * in production, the url we get in the express Request object
   * doesn't have the full pathname (it's missing the function name)
   * so we need to fix the url and pass it to validateExpressRequest
   */
  middleware: (req, res, next) => {
    if (!req.header('X-Twilio-Signature')) {
      return res.status(400).send('No signature header error');
    }

    let url = URL.format({
      protocol: req.protocol,
      host: req.hostname,
      pathname: req.originalUrl,
    });
    if (req.originalUrl.search(/\?/) >= 0) {
      url = url.replace(/%3F/g, '?');
    }
    if (!process.env.FUNCTIONS_EMULATOR) {
      url += process.env.FUNCTION_NAME;
    }

    const valid = twilio.validateExpressRequest(req, functions.config().twilio.auth_token, {
      url: url,
    });

    if (valid) {
      return next();
    } else {
      return res.status(403).send('Twilio Request Validation Failed');
    }
  },

  createEmptyMessageResponse: () => {
    const twiml = new MessagingResponse();
    return twiml.toString();
  },

  createEmptyVoiceResponse: () => {
    const twiml = new MessagingResponse();
    return twiml.toString();
  },

  createVoicemailRecordingPrompt: () => {
    const twiml = new VoiceResponse();
    twiml.play('https://firebasestorage.googleapis.com/v0/b/bedstuystrong-automation.appspot.com/o/voicemail_prompts%2Fvoicemail_karla_english_5-6.mp3?alt=media&token=dcd6cc68-be18-446a-981a-ddf68cb74898');
    twiml.play('https://firebasestorage.googleapis.com/v0/b/bedstuystrong-automation.appspot.com/o/voicemail_prompts%2Fvoicemail_karla_spanish_5-6.mp3?alt=media&token=e63d77a2-ada2-4c1a-a99a-c83db64d8801');
    twiml.pause({ length: 1 });
    twiml.record({
      action: '/inbound-empty',  // do nothing so that the transcription can happen
      timeout: 10,
      transcribe: true,
      transcribeCallback: '/inbound-voicemail',
    });
    return twiml.toString();
  },

  requestConnectCall: (phoneNumber, connectNumber) => {
    const twiml = new VoiceResponse();

    twiml.dial(connectNumber);

    return client.calls.create({
      to: phoneNumber,
      from: functions.config().twilio.outbound_number,
      twiml: twiml.toString(),
    });
  },

};