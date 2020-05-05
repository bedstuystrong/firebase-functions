const functions = require('firebase-functions');
const _ = require('lodash');

const {getRecordsWithStatus, INTAKE_TABLE, getTicketDueIn} = require('./airtable');

const IS_PROD = functions.config().environment.type === 'prod';

const ticketToGeojson = ([, fields,]) => {
  const encodedGeocode = _.trim(fields.geocode, '🔵');
  const geocodeString = Buffer.from(encodedGeocode, 'base64').toString('binary');
  const geocode = geocodeString && JSON.parse(geocodeString);

  let urgency, urgencyEmoji;
  if (fields.daysLeftToComplete < 0) {
    urgency = 0;
    urgencyEmoji = '🔥';
  } else if (fields.daysLeftToComplete < 1) {
    urgency = 1;
    urgencyEmoji = '⚠️';
  } else {
    urgency = 2;
    urgencyEmoji = '🐢';
  }

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: geocode ? [geocode.o.lng, geocode.o.lat] : [],
    },
    properties: Object.assign(fields, {
      urgency,
      urgencyEmoji,
    }),
    // properties: _.pick(fields,
    //   'ticketID',
    //   'householdSize',
    //   'nearestIntersection',
    //   'dueDate',
    //   'slackPostThreadLink',
    // ),
  };
};

module.exports = {

  unassignedTickets: functions.https.onRequest(async (_req, res) => {
    const unassignedTickets = _.filter(
      await getRecordsWithStatus(INTAKE_TABLE, 'Seeking Volunteer'),
      ([, fields, meta]) => !meta.ignore && fields.geocode,
    );
    // res.set('Access-Control-Allow-Origin', IS_PROD ? 'https://bedstuystrong.com' : 'http://localhost:5000');
    res.set('Access-Control-Allow-Origin', 'http://localhost:5000');
    res.json({
      type: 'FeatureCollection',
      features: unassignedTickets.map(ticketToGeojson),
    });
  }),

};