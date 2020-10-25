const functions = require('firebase-functions');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const allSettled = require('promise.allsettled');
const _ = require('lodash');

const {
  getRecordsWithPhoneNumber,
  INTAKE_TABLE,
  PHONE_NUMBERS_TABLE,
} = require('./airtable');

allSettled.shim();

const IS_PROD = functions.config().environment.type === 'prod';

const acceptableTicketFields = ['ticketID', 'status', 'recordID', 'requestName', 'nearestIntersection', 'phoneNumber', 'dateCreated', 'dateCompleted'];

const flexMiddleware = (req, res, next) => {
  const allowedOrigins = ['https://flex.twilio.com'];
  if (!IS_PROD) {
    allowedOrigins.push('http://localhost:3000');
  }

  if (!req.headers.origin) {
    return res.status(401).send('Unauthorized');
  } else if (allowedOrigins.includes(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  }

  if (!req.query.accountSid || req.query.accountSid !== functions.config().twilio.mass_messaging.sid) {
    res.json([]);
  }

  return next();
};

module.exports = {

  findTicketsByPhoneNumber: functions.https.onRequest((req, res) => {
    return flexMiddleware(req, res, async () => {
      if (!req.query.phoneNumber) {
        res.json([]);
      }

      const phoneNumber = parsePhoneNumberFromString(req.query.phoneNumber).formatNational();
      const tickets = await getRecordsWithPhoneNumber(INTAKE_TABLE, phoneNumber);

      const cleanTickets = tickets.map(([, fields,]) => {
        const filteredFields = _.pick(fields, acceptableTicketFields);
        return Object.assign(filteredFields, {
          phoneNumber: req.query.phoneNumber,
        });
      });

      return res.json(cleanTickets);
    });
  }),

  findPhoneNumber: functions.https.onRequest((req, res) => {
    return flexMiddleware(req, res, async () => {
      if (!req.query.phoneNumber) {
        res.json([]);
      }

      const phoneNumber = parsePhoneNumberFromString(req.query.phoneNumber).formatNational();
      const contacts = await getRecordsWithPhoneNumber(PHONE_NUMBERS_TABLE, phoneNumber);

      const [, contact,] = contacts[0];

      return res.json(contact);
    });
  }),

};