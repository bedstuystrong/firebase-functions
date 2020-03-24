const functions = require('firebase-functions');
const twilio = require('twilio');
const URL = require('url');

const { MessagingResponse, VoiceResponse } = twilio.twiml;


module.exports = {

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
    twiml.say('Please leave a message and we\'ll get back to you as soon as possible.');
    twiml.pause({ length: 1 });
    twiml.record({
      action: '/intake-empty',  // do nothing so that the transcription can happen
      timeout: 10,
      transcribe: true,
      transcribeCallback: '/intake-voicemail',
    });
    return twiml.toString();
  },

};