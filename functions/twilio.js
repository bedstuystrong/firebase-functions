const functions = require('firebase-functions');
const twilio = require('twilio');

const { MessagingResponse, VoiceResponse } = twilio.twiml;

module.exports = {

  webhookMiddleware: twilio.webhook(functions.config().twilio.auth_token),

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