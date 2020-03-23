const functions = require('firebase-functions');
const twilio = require('twilio')(functions.config().twilio.sid, functions.config().twilio.auth_token);
const { MessagingResponse } = require('twilio').twiml;

module.exports = {

  createEmptyTwimlResponse: () => {
    const twiml = new MessagingResponse();
    return twiml.toString();
  },

};