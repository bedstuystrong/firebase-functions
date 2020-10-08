const functions = require('firebase-functions');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const allSettled = require('promise.allsettled');
const _ = require('lodash');

const {
  getRecordsWithPhoneNumber,
  // getRecord,
  // VOLUNTEER_FORM_TABLE,
  INTAKE_TABLE,
} = require('./airtable');

allSettled.shim();

const acceptableFields = ['ticketID', 'status', 'recordID', 'requestName', 'nearestIntersection', 'phoneNumber', 'dateCreated', 'dateCompleted'];

module.exports = {

  findTicketsByPhoneNumber: functions.https.onRequest(async (req, res) => {
    if (!req.headers.origin) {
      return res.status(401).send('Unauthorized');
    }

    // res.set('Access-Control-Allow-Origin', 'https://bedstuystrong-automation-a4b75.web.app');
    // res.set('Access-Control-Allow-Origin', 'https://flex.twilio.com ');
    res.set('Access-Control-Allow-Origin', 'http://localhost:3000');

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

    // const ticketsWithVolunteers = await Promise.allSettled(tickets.map(async ([, fields, ]) => {
    //   const [, intakeVolunteer, ] = await getRecord(VOLUNTEER_FORM_TABLE, fields.intakeVolunteer);
    //   const [, deliveryVolunteer, ] = await getRecord(VOLUNTEER_FORM_TABLE, fields.deliveryVolunteer);

    //   const filteredFields = _.pick(fields, acceptableFields);

    //   return Object.assign(filteredFields, {
    //     phoneNumber: req.query.phoneNumber,
    //     intakeVolunteer: intakeVolunteer.name,
    //     deliveryVolunteer: deliveryVolunteer.name,
    //   });
    // }));

    // TODO
    // if (_.some(ticketsWithVolunteers, ['status', 'rejected'])) {
    //    handle error
    // }

    // res.json(ticketsWithVolunteers.map(result => result.value));
  }),

};