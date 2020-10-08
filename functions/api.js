const functions = require('firebase-functions');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const allSettled = require('promise.allsettled');
const _ = require('lodash');

const {
  getRecordsWithPhoneNumber,
  INTAKE_TABLE,
} = require('./airtable');

allSettled.shim();

const acceptableFields = ['ticketID', 'status', 'recordID', 'requestName', 'nearestIntersection', 'phoneNumber', 'dateCreated', 'dateCompleted'];

module.exports = {

  findTicketsByPhoneNumber: functions.https.onRequest(async (req, res) => {
    if (!req.headers.origin) {
      return res.status(401).send('Unauthorized');
    }

    res.set('Access-Control-Allow-Origin', 'https://flex.twilio.com');

    if (!req.query.phoneNumber) {
      res.json([]);
    }

    if (!req.query.accountSid || req.query.accountSid !== functions.config().twilio.mass_messaging.sid) {
      res.json([]);
    }

    const phoneNumber = parsePhoneNumberFromString(req.query.phoneNumber).formatNational();
    const tickets = await getRecordsWithPhoneNumber(INTAKE_TABLE, phoneNumber);

    const cleanTickets = tickets.map(([, fields, ]) => {
      const filteredFields = _.pick(fields, acceptableFields);
      return Object.assign(filteredFields, {
        phoneNumber: req.query.phoneNumber,
      });
    });

    res.json(cleanTickets);
  }),

};