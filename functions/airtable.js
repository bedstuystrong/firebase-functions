const functions = require('firebase-functions');
const Airtable = require('airtable');

const airtable = new Airtable({
  apiKey: functions.config().airtable.api_key,
});

const base = airtable.base(functions.config().airtable.base_id);

const INTAKE_CONTACTS = functions.config().airtable.intake_contacts_table;
const INTAKE_MESSAGES = functions.config().airtable.intake_messages_table;
const VOLUNTEER_FORM = functions.config().airtable.volunteers_table
// const INBOUND = functions.config().airtable.inbound_table;
const INTAKE = functions.config().airtable.intake_table;

function getPhoneNumberId(phoneNumber) {
  return base(INTAKE_CONTACTS).select({
    maxRecords: 1,
    filterByFormula: `{phone_number} = "${phoneNumber}"`
  }).firstPage().then(records => {
    if (records[0]) {
      return records;
    } else {
      return base(INTAKE_CONTACTS).create([
        {
          fields: {
            phone_number: phoneNumber,
            intake_status: 'intake needed'
          }
        }
      ]);
    }
  }).then(records => records[0].id)
}

function createMessage(phoneNumberId, message) {
  return base(INTAKE_MESSAGES).create([
    {
      fields: {
        type: 'SMS',
        phone_number: [phoneNumberId],
        message: message,
      }
    },
  ])
}

function createVoicemail(phoneNumberId, recordingUrl, message) {
  base(INTAKE_MESSAGES).create([
    {
      fields: {
        type: 'Voicemail',
        phone_number: [phoneNumberId],
        recording_url: recordingUrl,
        message: message,
      }
    },
  ])
}

async function getAllIntakeTickets() {
  const query = base(INTAKE).select()
  const records = await query.all()

  return records.map(
    rec => [
      rec.id,
      rec.fields,
      (rec.fields["_meta"]) ? JSON.parse(rec.fields["_meta"]) : {}
    ]
  )
}

// Returns only intake tickets that haven't been processed yet
// NOTE that we accomplish this by updating a `_meta` field in the record's airtable entry
async function getChangedIntakeTickets() {
  // Get all tickets with updated statuses
  return (await getAllIntakeTickets()).filter(
    ([, fields, meta]) => {
      // TODO that "Status" is still missing for some of the tickets in airtable
      if (Object.keys(meta).length === 0 && fields["Status"]) {
        return true
      }

      // eslint-disable-next-line eqeqeq
      return fields["Status"] != meta["lastSeenStatus"]
    }
  )
}

// TODO : return the new record
async function updateIntakeTicket(id, delta, meta) {
  let fields = Object.assign({}, delta)

  if (meta) {
    fields["_meta"] = JSON.stringify(meta)
  }
 
  await base(INTAKE).update(id, fields)
}

async function getVolunteerSlackID(volunteerID) {
  const rec = await base(VOLUNTEER_FORM).find(volunteerID)

  return rec.fields["Slack User ID"]
}

module.exports = {
  getPhoneNumberId: getPhoneNumberId,
  createMessage: createMessage,
  createVoicemail: createVoicemail,
  getAllIntakeTickets: getAllIntakeTickets,
  getChangedIntakeTickets: getChangedIntakeTickets,
  updateIntakeTicket: updateIntakeTicket,
  getVolunteerSlackID: getVolunteerSlackID,
}
