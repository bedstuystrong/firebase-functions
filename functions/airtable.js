const functions = require('firebase-functions');

const _ = require('lodash');

const Airtable = require('airtable');

const {
  INBOUND_SCHEMA,
  INBOUND_STATUSES,
  INTAKE_SCHEMA,
  META_STORE_KEYS,
  REIMBURSEMENT_SCHEMA,
  VOLUNTEER_SCHEMA,
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

const TABLE_SCHEMAS = {
  [INBOUND_TABLE]: INBOUND_SCHEMA,
  [INTAKE_TABLE]: INTAKE_SCHEMA,
  [VOLUNTEER_FORM_TABLE]: VOLUNTEER_SCHEMA,
  [REIMBURSEMENTS_TABLE]: REIMBURSEMENT_SCHEMA,
};

/* GENERAL */

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

async function getRecordsWithOptions(table, options) {
  const query = base(table).select(options);
  const records = await query.all();
  return records.map(normalizeRecords(table));
}

async function getIntakeTicketsWithoutLinks() {
  return await getRecordsWithOptions(
    INTAKE_TABLE,
    {
      filterByFormula: `AND({Status} = "Seeking Volunteer", 0 = COUNTA({Phone/Text Inbound (For call back!)}))`
    }
  )
}

async function findInboundTicketForIntakeTicket([, fields,]) {
  const candidates = await getRecordsWithOptions(
    INBOUND_TABLE,
    {
      filterByFormula: `AND({Status} != "Duplicate", {Phone Number} = "${fields.phoneNumber}", {Intake Time} < "${fields.dateCreated}")`
    }
  )
  const candidatesMatchingIntakeVolunteer = _.filter(candidates, ([, candidateFields,]) => (
    _.intersection(fields.intakeVolunteer, _.flatten(candidateFields.intakeVolunteer)).length > 0
  ))

  if (candidatesMatchingIntakeVolunteer.length >= 1) {
    if (candidatesMatchingIntakeVolunteer.length > 1) {
      console.log('findInboundTicketForIntakeTicket: multiple matching candidates, taking latest for ticket', fields.ticketID)
    }
    return _.maxBy(candidatesMatchingIntakeVolunteer, ([, candidateFields,]) => candidateFields.intakeTime)
  } else if (candidates.length === 1) {
    console.log('findInboundTicketForIntakeTicket: could not match intake volunteer but only one candidate', fields.ticketID)
    return candidates[0]
  } else if (candidates.length > 1) {
    console.error('findInboundTicketForIntakeTicket: multiple candidates with no matching intake volunteer for ticket', fields.ticketID)
    candidates.forEach(([, candidateFields,]) => console.log({
      phoneNumber: candidateFields.phoneNumber,
      intakeVolunteer: candidateFields.intakeVolunteer,
      intakeTime: candidateFields.intakeTime,
      intakeTicket: candidateFields['Intake Ticket']
    }))
    return null
  } else {
    console.error('findInboundTicketForIntakeTicket: no matching candidates for ticket', fields.ticketID)
    return null
  }
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

/* INBOUND */

function createMessage(phoneNumber, message) {
  // NOTE that we set a `null` status for the record, and let the `onNewInbound` poll function set the status
  const fields = denormalize({
    method: 'Text Message',
    phoneNumber: phoneNumber,
    message: message,
  }, INBOUND_SCHEMA);
  return base(INBOUND_TABLE).create([{ fields }]);
}

function createVoicemail(phoneNumber, recordingUrl, message) {
  // NOTE that we set a `null` status for the record, and let the `onNewInbound` poll function set the status
  const fields = denormalize({
    method: 'Phone Call',
    phoneNumber: phoneNumber,
    message: message,
    voicemailRecording: recordingUrl,
  }, INBOUND_SCHEMA);
  return base(INBOUND_TABLE).create([{ fields }]);
}

// This function retrieves the last non-duplicate ticket for a phone number, which is used for
// handling multiple inbound messages from the same phone number.
async function getLastNonDuplicate(phoneNumber) {
  const query = base(INBOUND_TABLE).select({
    filterByFormula: `{${INBOUND_SCHEMA.phoneNumber}} = "${phoneNumber}"`
  });
  const records = (await query.all()).map(normalizeRecords(INBOUND_TABLE));

  // NOTE that we return `null` if there were no prior inbound records
  return _.last(
    _.filter(
      _.sortBy(
        records,
        ([, fields,]) => {
          return new Date(fields.dateCreated);
        }
      ),
      ([, fields,]) => {
        return !_.isNull(fields.status) && fields.status !== INBOUND_STATUSES.duplicate;
      },
    )
  ) || null;
}


/* VOLUNTEER */

async function getVolunteerSlackID(volunteerID) {
  // Ensures that all DMs go to the test user
  if (!IS_PROD) {
    return functions.config().slack.test_user_id;
  }

  const rec = await base(VOLUNTEER_FORM_TABLE).find(volunteerID);
  return normalize(rec.fields, VOLUNTEER_SCHEMA).slackUserID;
}

/* INTAKE */

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

/* META */

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

/* EXPORT */

module.exports = {
  INBOUND_TABLE: INBOUND_TABLE,
  INTAKE_TABLE: INTAKE_TABLE,
  META_STORE_KEYS: META_STORE_KEYS,
  META_TABLE: META_TABLE,
  REIMBURSEMENTS_TABLE: REIMBURSEMENTS_TABLE,
  VOLUNTEER_FORM_TABLE: VOLUNTEER_FORM_TABLE,
  createMessage: createMessage,
  createVoicemail: createVoicemail,
  findInboundTicketForIntakeTicket: findInboundTicketForIntakeTicket,
  getAllRecords: getAllRecords,
  getChangedRecords: getChangedRecords,
  getIntakeTicketsWithoutLinks: getIntakeTicketsWithoutLinks,
  getLastNonDuplicate: getLastNonDuplicate,
  getMeta: getMeta,
  getRecord: getRecord,
  getRecordsWithStatus: getRecordsWithStatus,
  getRecordsWithTicketID: getRecordsWithTicketID,
  getTicketDueDate: getTicketDueDate,
  getTicketDueIn: getTicketDueIn,
  getVolunteerSlackID: getVolunteerSlackID,
  storeMeta: storeMeta,
  updateRecord: updateRecord,
};
