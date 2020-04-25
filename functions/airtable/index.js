const functions = require('firebase-functions');

const _ = require('lodash');

const Airtable = require('airtable');

const {
  INBOUND_SCHEMA,
  INTAKE_SCHEMA,
  META_STORE_KEYS,
  REIMBURSEMENT_SCHEMA,
  VOLUNTEER_SCHEMA,
  FINANCE_TRANSACTIONS_SCHEMA,
  denormalize,
  normalize,
} = require('./schema');

const IS_PROD = functions.config().environment.type === 'prod';

const airtable = new Airtable({
  apiKey: functions.config().airtable.api_key,
});

const base = airtable.base(functions.config().airtable.base_id);

const INBOUND_TABLE = functions.config().airtable.inbound_table;
const VOLUNTEER_FORM_TABLE = functions.config().airtable.volunteers_table;
const INTAKE_TABLE = functions.config().airtable.intake_table;
const REIMBURSEMENTS_TABLE = functions.config().airtable.reimbursements_table;
const META_TABLE = functions.config().airtable.meta_table;

const FINANCE_TRANSACTIONS_TABLE = functions.config().airtable.finance_transactions_table;

const TABLE_SCHEMAS = {
  [INBOUND_TABLE]: INBOUND_SCHEMA,
  [INTAKE_TABLE]: INTAKE_SCHEMA,
  [VOLUNTEER_FORM_TABLE]: VOLUNTEER_SCHEMA,
  [REIMBURSEMENTS_TABLE]: REIMBURSEMENT_SCHEMA,
};

function createMessage(phoneNumber, message) {
  const fields = denormalize({
    status: 'Intake Needed',
    method: 'Text Message',
    phoneNumber: phoneNumber,
    message: message,
  }, INBOUND_SCHEMA);
  return base(INBOUND_TABLE).create([{ fields }]);
}

function createVoicemail(phoneNumber, recordingUrl, message) {
  const fields = denormalize({
    status: 'Intake Needed',
    method: 'Phone Call',
    phoneNumber: phoneNumber,
    message: message,
    voicemailRecording: recordingUrl,
  }, INBOUND_SCHEMA);
  return base(INBOUND_TABLE).create([{ fields }]);
}

function normalizeRecords(table) {
  const schema = TABLE_SCHEMAS[table];
  return function normalizeRecord(record) {
    // TODO make this an object
    return [
      record.id,
      normalize(record.fields, schema),
      record.fields._meta ? JSON.parse(record.fields._meta) : {}
    ];
  };
}

async function getAllRecords(table) {
  const records = await base(table).select().all();
  return records.map(normalizeRecords(table));
}

async function getRecord(table, recordID) {
  const rec = await base(table).find(recordID);
  return normalizeRecords(table)(rec);
}

async function getRecordsWithTicketID(table, ticketID) {
  const query = base(table).select({
    filterByFormula: `{Ticket ID} = "${ticketID}"`
  });
  const records = await query.all();
  return records.map(normalizeRecords(table));
}

async function getRecordsWithStatus(table, status) {
  const query = base(table).select({
    filterByFormula: `{Status} = "${status}"`
  });
  const records = await query.all();
  return records.map(normalizeRecords(table));
}

// Returns only intake tickets whose status has changed since we last checked. If `includeNullStatus`
// is true, we will include records without a status.
//
// NOTE that we accomplish this by updating a `_meta` field in the record's airtable entry
// NOTE that this function will only work if the table has a `Status` field
async function getChangedRecords(table, includeNullStatus = false) {
  // Get all tickets with updated statuses
  const allRecords = await getAllRecords(table);
  return allRecords.filter(
    ([, fields, meta]) => {
      if (_.isNull(fields.status) && Object.keys(meta).length === 0) {
        return includeNullStatus;
      } else if (Object.keys(meta).length === 0) {
        // This is a non-null status, and we haven't written down our meta yet
        return true;
      } else {
        return fields.status !== meta.lastSeenStatus;
      }
    }
  );
}

async function updateRecord(table, id, delta, meta) {
  let fields = denormalize(delta, TABLE_SCHEMAS[table]);

  if (meta) {
    fields._meta = JSON.stringify(meta);
  }

  return normalizeRecords(table)(await base(table).update(id, fields));
}

async function getVolunteerSlackID(volunteerID) {
  // Ensures that all DMs go to the test user
  if (!IS_PROD) {
    return functions.config().slack.test_user_id;
  }

  const rec = await base(VOLUNTEER_FORM_TABLE).find(volunteerID);
  return normalize(rec.fields, VOLUNTEER_SCHEMA).slackUserID;
}

// Returns the number of days left to complete the ticket
// TODO : come back and make sure the math here represents what we want
function getTicketDueIn(fields) {
  return Math.round(
    (getTicketDueDate(fields) - Date.now()) / (1000 * 60 * 60 * 24)
  );
}

// Returns the number of days left to complete the ticket
function getTicketDueDate(fields) {
  const NEED_IMMEDIACY_TO_DAYS = {
    'Before the end of the day': 1,
    'Within a day or two': 2,
    'Within a week': 7,
    'As soon as possible': 0,
  };

  const dateCreated = new Date(fields.dateCreated);
  const daysAllotted = NEED_IMMEDIACY_TO_DAYS[fields.timeline];

  return new Date(
    dateCreated.getTime() + daysAllotted * (1000 * 60 * 60 * 24)
  );
}

async function _findMetaRecord(key) {
  if (!Object.values(META_STORE_KEYS).includes(key)) {
    throw Error('The provided key is not a valid key in the meta store', { key: key });
  }

  const query = base(META_TABLE).select({
    filterByFormula: `{Name} = "${key}"`
  });
  const records = (await query.all()).map(normalizeRecords(META_TABLE));

  if (records.length === 0) {
    throw Error('Did not find a meta entry', { key: key });
  } else if (records.length > 1) {
    throw Error('Found duplicate meta entries', { key: key });
  }

  return records[0];
}

// Gets a meta object stored in the `_meta` table
async function getMeta(key) {
  return (await _findMetaRecord(key))[2];
}

async function storeMeta(key, data) {
  return await updateRecord(META_TABLE, (await _findMetaRecord(key))[0], {}, data);
}

async function createFinanceTransaction({ direction, platform, amount, name, note, accountHolder, date }) {
  const financeBase = airtable.base(functions.config().airtable.finance_base_id);

  const directionID = {
    In: 'recHqZivpo6j4T6On',
    Out: 'reckW3l4mK8BCEBsd',
  }[direction];

  const fields = denormalize({
    direction: [directionID],
    platform: platform,
    amount: amount,
    name: name,
    notes: note,
    accountHolder: accountHolder,
    date: date,
  }, FINANCE_TRANSACTIONS_SCHEMA);

  return financeBase(FINANCE_TRANSACTIONS_TABLE).create(
    [{ fields }],
    { typecast: true }
  );
}

module.exports = {
  INBOUND_TABLE: INBOUND_TABLE,
  INTAKE_TABLE: INTAKE_TABLE,
  META_STORE_KEYS: META_STORE_KEYS,
  META_TABLE: META_TABLE,
  REIMBURSEMENTS_TABLE: REIMBURSEMENTS_TABLE,
  VOLUNTEER_FORM_TABLE: VOLUNTEER_FORM_TABLE,
  createMessage: createMessage,
  createVoicemail: createVoicemail,
  getAllRecords: getAllRecords,
  getRecord: getRecord,
  getChangedRecords: getChangedRecords,
  getMeta: getMeta,
  getPhoneNumberId: getPhoneNumberId,
  getRecord: getRecord,
  getRecordsWithStatus: getRecordsWithStatus,
  getRecordsWithTicketID: getRecordsWithTicketID,
  getTicketDueIn: getTicketDueIn,
  getTicketDueDate: getTicketDueDate,
  getVolunteerSlackID: getVolunteerSlackID,
  storeMeta: storeMeta,
  updateRecord: updateRecord,
  createFinanceTransaction: createFinanceTransaction,
};
