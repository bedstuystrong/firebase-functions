const functions = require('firebase-functions');
const Airtable = require('airtable');

const airtable = new Airtable({
  apiKey: functions.config().airtable.api_key,
});

const base = airtable.base(functions.config().airtable.base_id);

const INBOUND_CONTACTS = functions.config().airtable.inbound_contacts_table;
const INBOUND = functions.config().airtable.inbound_table;
const INTAKE = functions.config().airtable.intake_table;

const FIELD_NAMES = {
  method: 'Method of Contact',
  status: 'Status',
  phoneNumber: 'Phone Number',
  message: 'Message',
  voicemailRecording: 'Voicemail Recording',
};

function getPhoneNumberId(phoneNumber) {
  return base(INBOUND_CONTACTS).select({
    maxRecords: 1,
    filterByFormula: `{phone_number} = "${phoneNumber}"`
  }).firstPage().then(records => {
    if (records[0]) {
      return records;
    } else {
      return base(INBOUND_CONTACTS).create([
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
  return base(INBOUND).create([
    {
      fields: {
        [FIELD_NAMES.method]: 'Text Message',
        [FIELD_NAMES.status]: 'Intake Needed',
        [FIELD_NAMES.phoneNumber]: phoneNumber,
        [FIELD_NAMES.message]: message,
      }
    },
  ]);
}

function createVoicemail(phoneNumber, recordingUrl, message) {
  return base(INBOUND).create([
    {
      fields: {
        [FIELD_NAMES.method]: 'Phone Call',
        [FIELD_NAMES.status]: 'Intake Needed',
        [FIELD_NAMES.phoneNumber]: phoneNumber,
        [FIELD_NAMES.message]: message,
        [FIELD_NAMES.voicemailRecording]: recordingUrl,
      }
    },
  ]);
}

async function getAllIntakeTickets() {
  const query = base(INTAKE).select();
  const records = await query.all();

  return records.map(rec => [rec.id, rec.fields]);
}

// Returns only intake tickets whose status has changed since we last checked
// NOTE that we accomplish this by updating a `_meta` field in the record's airtable entry
async function getChangedIntakeTickets() {
  // Get all tickets with updated statuses
  const res = (await getAllIntakeTickets()).filter(
    ([, fields]) => {
      // TODO that "Status" is still missing for some of the tickets in airtable
      if (!fields['_meta'] && fields['Status']) {
        return true;
      }

      const meta = JSON.parse(fields['_meta']);

      // eslint-disable-next-line eqeqeq
      return fields['Status'] != meta['lastSeenStatus'];
    }
  );

  // For all of these fields, set their `_meta` field
  const updates = [];
  for (const [id, fields] of res) {
    let meta = (fields['_meta']) ? JSON.parse(fields['_meta']) : {};
    meta['lastSeenStatus'] = fields['Status'] || null;

    updates.push(base(INTAKE).update(id, { _meta: JSON.stringify(meta) }));
  }
  await Promise.all(updates);

  return res;
}

module.exports = {
  getPhoneNumberId: getPhoneNumberId,
  createMessage: createMessage,
  createVoicemail: createVoicemail,
  getAllIntakeTickets: getAllIntakeTickets,
  getChangedIntakeTickets: getChangedIntakeTickets
};
