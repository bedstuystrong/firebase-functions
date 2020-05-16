const _ = require('lodash');

// Airtable schema mapping

const STATUS = 'Status';
const META = '_meta';

const META_STORE_KEYS = {
  digestPostInfo: 'digest_post_info',
};

const INBOUND_SCHEMA = {
  status: STATUS,
  method: 'Method of Contact',
  phoneNumber: 'Phone Number',
  message: 'Message',
  voicemailRecording: 'Voicemail Recording',
  intakeVolunteer: 'Intake Volunteer',
  intakeTime: 'Intake Time',
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
  nearestIntersection: 'Nearest Intersection',
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
  dueDate: 'Due Date',
  costCategory: 'cost_category',
};

const REIMBURSEMENT_SCHEMA = {
  status: STATUS,
  // XXX : 'Ticket ID' is being deprecated, use 'Ticket Records'
  ticketID: 'Ticket ID',
  ticketRecords: 'Ticket Records',
  totalCost: 'Total Cost',
  donation: 'Donation',
  netReimbursement: 'Net Reimbursement',
  // TODO : get rid of this nonesense
  fundMgr: 'FundMGR Reimbursed',
  dateSubmitted: 'Date / Time Submitted',
  paymentPlatform: 'Payment Platform',
};

const VOLUNTEER_SCHEMA = {
  status: STATUS,
  email: 'Email Address',
  slackUserID: 'Slack User ID',
  slackEmail: 'Email Address (from Slack)',
  slackHandle: 'Slack Handle',
  slackHandleDerived: 'Slack Handle (Derived)',
  phoneNumber: 'Phone Number',
};

const META_SCHEMA = {
  name: 'Name',
};

const normalize = (object, schema) => {
  const invertedSchema = _.invert(schema);
  const normalized = _.mapKeys(object, (_value, key) => (invertedSchema[key] || key));

  // NOTE that the record from airtable doesn't include keys with empty fields
  // Add in `null` values for all the keys in the schema but not in the record
  return _.assign(
    _.mapValues(schema, () => null),
    normalized,
  );
};

// TODO : we might not need to remove null keys. Will that allow us to set empty
// values to cells in airtable?
const denormalize = (object, schema) => {
  // Remove null keys and map back to original schema
  return _.mapKeys(
    _.pickBy(object, (value) => !_.isNull(value)),
    (_value, key) => (schema[key] || key)
  );
};

module.exports = {
  INBOUND_SCHEMA,
  INTAKE_SCHEMA,
  META,
  META_SCHEMA,
  META_STORE_KEYS,
  REIMBURSEMENT_SCHEMA,
  STATUS,
  VOLUNTEER_SCHEMA,
  denormalize,
  normalize,
};