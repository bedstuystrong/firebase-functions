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
  otherInbounds: 'Other Inbounds',
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
  foodOptions: 'Food Options',
  otherItems: 'Other Items',
};

const BULK_DELIVERY_STATUSES = ['Bulk Delivery Scheduled', 'Bulk Delivery Confirmed'];

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

const ITEMS_BY_HOUSEHOLD_SIZE_SCHEMA = {
  item: 'Item',
  unit: 'Unit',
  1: '1 Person(s)',
  2: '2 Person(s)',
  3: '3 Person(s)',
  4: '4 Person(s)',
  5: '5 Person(s)',
  6: '6 Person(s)',
  7: '7 Person(s)',
  8: '8 Person(s)',
};

const BULK_ORDER_SCHEMA = {
  item: 'Item',
  unit: 'Unit',
  quantity:  'Quantity',
  deliveryDate: 'Bulk Delivery Date',
};

const INBOUND_STATUSES = {
  intakeNeeded: 'Intake Needed',
  inProgress: 'In Progress',
  intakeComplete: 'Intake Complete',
  duplicate: 'Duplicate',
  outsideBedStuy: 'Outside Bed-Stuy',
  callBack: 'Call Back',
  question: 'Question/Info',
  thankYou: 'Thank you!',
  spanishIntakeNeeded: 'Spanish-Intake needed',
  noNeed: 'No longer needs assistance',
  phoneTag: 'Phone Tag',
  outOfService: 'Out of Service/Cannot Reach',
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
  BULK_ORDER_SCHEMA,
  BULK_DELIVERY_STATUSES,
  INBOUND_SCHEMA,
  INBOUND_STATUSES,
  INTAKE_SCHEMA,
  ITEMS_BY_HOUSEHOLD_SIZE_SCHEMA,
  META,
  META_SCHEMA,
  META_STORE_KEYS,
  REIMBURSEMENT_SCHEMA,
  STATUS,
  VOLUNTEER_SCHEMA,
  denormalize,
  normalize,
};