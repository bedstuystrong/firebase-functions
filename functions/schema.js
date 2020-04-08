const mapKeys = require('lodash/mapKeys');
const invert = require('lodash/invert');
// Airtable schema mapping

const STATUS = 'Status';
const META = '_meta';

const INBOUND_SCHEMA = {
  status: STATUS,
  method: 'Method of Contact',
  phoneNumber: 'Phone Number',
  message: 'Message',
  voicemailRecording: 'Voicemail Recording',
};

const INTAKE_SCHEMA = {
  ticketID: 'Ticket ID',
  status: STATUS,
  intakeVolunteer: 'Intake Volunteer - This is you!',
  deliveryVolunteer: 'Delivery Volunteer',
  neighborhood: 'Neighborhood',
  requestName: 'Requestor First Name and Last Initial',
  timeline: 'Need immediacy',
  category: 'Need Category',
  crossStreets: 'Cross Streets',
  description: 'Task Overview - Posts in Slack',
  language: 'Language',
  items: 'Items / Services Requested - Posts in Slack',
  address: 'Address (won\'t post in Slack)',
  phoneNumber: 'Phone Number',
  vulnerability: 'Vulnerability',
  householdSize: 'Household Size',
  deliveryNotes: 'Notes for Delivery Volunteer (won\'t post in Slack)',
  dateCreated: 'Date Created',
  slackPostLink: 'Slack Post Link',
  slackPostThreadLink: 'Slack Post Thread Link',
};

const REIMBURSEMENT_SCHEMA = {
  status: STATUS,
  ticketID: 'Ticket ID',
};

const VOLUNTEER_SCHEMA = {
  status: STATUS,
  email: 'Email Address',
  slackUserID: 'Slack User ID',
  slackEmail: 'Email Address (from Slack)',
  slackHandle: 'Slack Handle',
  slackHandleDerived: 'Slack Handle (Derived)',
};

const normalize = (object, schema) => {
  const invertedSchema = invert(schema);
  return mapKeys(object, (_value, key) => (invertedSchema[key] || key));
};
const denormalize = (object, schema) => mapKeys(object, (_value, key) => (schema[key] || key));

module.exports = {
  normalize,
  denormalize,
  STATUS,
  META,
  INBOUND_SCHEMA,
  INTAKE_SCHEMA,
  REIMBURSEMENT_SCHEMA,
  VOLUNTEER_SCHEMA,
};