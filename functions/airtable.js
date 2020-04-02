const functions = require('firebase-functions');
const Airtable = require('airtable');

const {
  normalize,
  denormalize,
  INBOUND_SCHEMA,
  INTAKE_SCHEMA,
  VOLUNTEER_SCHEMA,
  REIMBURSEMENT_SCHEMA,
} = require('./schema');

const IS_PROD = functions.config().environment.type === 'prod'

const airtable = new Airtable({
  apiKey: functions.config().airtable.api_key,
});

const base = airtable.base(functions.config().airtable.base_id);

const INBOUND_CONTACTS_TABLE = null; // functions.config().airtable.inbound_contacts_table;
const INBOUND_TABLE = functions.config().airtable.inbound_table;
const VOLUNTEER_FORM_TABLE = functions.config().airtable.volunteers_table;
const INTAKE_TABLE = functions.config().airtable.intake_table;
const REIMBURSEMENTS_TABLE = functions.config().airtable.reimbursements_table;

const TABLE_SCHEMAS = {
  [INBOUND_TABLE]: INBOUND_SCHEMA,
  [INTAKE_TABLE]: INTAKE_SCHEMA,
  [VOLUNTEER_FORM_TABLE]: VOLUNTEER_SCHEMA,
  [REIMBURSEMENTS_TABLE]: REIMBURSEMENT_SCHEMA,
};

function getPhoneNumberId(phoneNumber) {
  return base(INBOUND_CONTACTS_TABLE).select({
    maxRecords: 1,
    filterByFormula: `{phone_number} = "${phoneNumber}"`
  }).firstPage().then(records => {
    if (records[0]) {
      return records;
    } else {
      return base(INBOUND_CONTACTS_TABLE).create([
        {
          fields: {
            phone_number: phoneNumber,
            intake_status: 'Intake Needed'
          }
        }
      ]);
    }
  }).then(records => records[0].id);
}

function createMessage(phoneNumber, message) {
  const fields = denormalize({
    status: 'Intake Needed',
    method: 'Text Message',
    phoneNumber: phoneNumber,
    message: message,
  });
  return base(INBOUND_TABLE).create([{ fields }]);
}

function createVoicemail(phoneNumber, recordingUrl, message) {
  const fields = denormalize({
    status: 'Intake Needed',
    method: 'Phone Call',
    phoneNumber: phoneNumber,
    message: message,
    voicemailRecording: recordingUrl,
  });
  return base(INBOUND_TABLE).create([{ fields }]);
}

function parseRecord(record) {
  return [
    record.id,
    normalize(record.fields),
    record.fields._meta ? JSON.parse(record.fields._meta) : {}
  ];
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

async function getRecordsWithTicketID(table, ticketID) {
  const query = base(table).select({
    filterByFormula: `{Ticket ID} = "${ticketID}"`
  });
  const records = await query.all();
  return records.map(normalizeRecords(table));
}

// Returns only intake tickets whose status has changed since we last checked
// NOTE that we accomplish this by updating a `_meta` field in the record's airtable entry
// NOTE that this function will only work if the table has a `Status` field
async function getChangedRecords(table) {
  // Get all tickets with updated statuses
  const allRecords = await getAllRecords(table);
  return allRecords.filter(
    ([, fields, meta]) => {
      // NOTE that "Status" is still missing in airtable indicates we should ignore this message
      if (Object.keys(meta).length === 0 && fields.status) {
        return true;
      }

      // eslint-disable-next-line eqeqeq
      return fields.status != meta.lastSeenStatus;
    }
  );
}

// TODO : return the new record
async function updateRecord(table, id, delta, meta) {
  let fields = denormalize(delta, TABLE_SCHEMAS[table]);

  if (meta) {
    fields._meta = JSON.stringify(meta);
  }

  return await base(table).update(id, fields);
}

async function getVolunteerSlackID(volunteerID) {
  // Ensures that all DMs go to the test user
  if (!IS_PROD) {
    return functions.config().slack.test_user_id;
  }

  const rec = await base(VOLUNTEER_FORM_TABLE).find(volunteerID);
  return normalize(rec.fields, VOLUNTEER_SCHEMA).slackUserID;
}

module.exports = {
  INBOUND_TABLE: INBOUND_TABLE,
  INTAKE_TABLE: INTAKE_TABLE,
  REIMBURSEMENTS_TABLE: REIMBURSEMENTS_TABLE,
  VOLUNTEER_FORM_TABLE: VOLUNTEER_FORM_TABLE,
  createMessage: createMessage,
  createVoicemail: createVoicemail,
  getAllRecords: getAllRecords,
  getChangedRecords: getChangedRecords,
  getPhoneNumberId: getPhoneNumberId,
  getRecordsWithTicketID: getRecordsWithTicketID,
  getVolunteerSlackID: getVolunteerSlackID,
  updateRecord: updateRecord,
};
