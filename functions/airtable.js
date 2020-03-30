const functions = require('firebase-functions');
const Airtable = require('airtable');

const airtable = new Airtable({
  apiKey: functions.config().airtable.api_key,
});

const base = airtable.base(functions.config().airtable.base_id);

const INBOUND_CONTACTS_TABLE = functions.config().airtable.inbound_contacts_table;
const INBOUND_TABLE = functions.config().airtable.inbound_table;
const VOLUNTEER_FORM_TABLE = functions.config().airtable.volunteers_table;
const INTAKE_TABLE = functions.config().airtable.intake_table;
const REIMBURSEMENTS_TABLE = functions.config().airtable.reimbursements_table;

// TODO can we store these easily in config?
const INBOUND_FIELD_NAMES = {
  method: 'Method of Contact',
  phoneNumber: 'Phone Number',
  message: 'Transcribed Message',
  voicemailRecording: 'Message Recording',
};

const STATUS = 'Status';

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
  return base(INBOUND_TABLE).create([
    {
      fields: {
        [STATUS]: 'Intake Needed',
        [INBOUND_FIELD_NAMES.method]: 'Text Message',
        [INBOUND_FIELD_NAMES.phoneNumber]: phoneNumber,
        [INBOUND_FIELD_NAMES.message]: message,
      }
    },
  ]);
}

function createVoicemail(phoneNumber, recordingUrl, message) {
  return base(INBOUND_TABLE).create([
    {
      fields: {
        [STATUS]: 'Intake Needed',
        [INBOUND_FIELD_NAMES.method]: 'Phone Call',
        [INBOUND_FIELD_NAMES.phoneNumber]: phoneNumber,
        [INBOUND_FIELD_NAMES.message]: message,
        [INBOUND_FIELD_NAMES.voicemailRecording]: recordingUrl,
      }
    },
  ]);
}

function _parseRecord(record) {
  return [
    record.id,
    record.fields,
    (record.fields._meta) ? JSON.parse(record.fields._meta) : {}
  ];
}

async function getAllRecords(table) {
  const records = await base(table).select().all();
  return records.map(_parseRecord);
}

async function getRecordsWithTicketID(table, ticketID) {
  const query = base(table).select({
    filterByFormula: `{Ticket ID} = "${ticketID}"`
  });
  const records = await query.all();

  return records.map(_parseRecord);
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
      if (Object.keys(meta).length === 0 && fields[STATUS]) {
        return true;
      }

      // eslint-disable-next-line eqeqeq
      return fields[STATUS] != meta.lastSeenStatus;
    }
  );
}

// TODO : return the new record
async function updateRecord(table, id, delta, meta) {
  let fields = Object.assign({}, delta);

  if (meta) {
    fields._meta = JSON.stringify(meta);
  }

  await base(table).update(id, fields);
}

async function getVolunteerSlackID(volunteerID) {
  const rec = await base(VOLUNTEER_FORM_TABLE).find(volunteerID);

  return rec.fields['Slack User ID'];
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
