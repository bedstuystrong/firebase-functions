const functions = require('firebase-functions');
const Airtable = require('airtable');

const airtable = new Airtable({
  apiKey: functions.config().airtable.api_key,
});

const base = airtable.base(functions.config().airtable.base_id);

const INTAKE_CONTACTS = functions.config().airtable.intake_contacts_table;
const INTAKE_MESSAGES = functions.config().airtable.intake_messages_table;
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

  return records.map(rec => [rec.id, rec.fields])
}

// Returns only intake tickets that haven't been processed yet
// NOTE that we accomplish this by updating a `_meta` field in the record's airtable entry
async function getChangedIntakeTickets() {
  // Get all tickets with updated statuses
  const res = (await getAllIntakeTickets()).filter(
    ([, fields]) => {
      // TODO that "Status" is still missing for some of the tickets in airtable
      if (!fields["_meta"] && fields["Status"]) {
        return true
      }

      const meta = JSON.parse(fields["_meta"])

      // eslint-disable-next-line eqeqeq
      return fields["Status"] != meta["lastSeenStatus"]
    }
  )

  // For all of these fields, set their `_meta` field
  for (const [id, fields] of res) {
    let meta = (fields["_meta"]) ? JSON.parse(fields["_meta"]) : {}
    meta["lastSeenStatus"] = fields["Status"] || null

    await base(INTAKE).update(id, { "_meta": JSON.stringify(meta) })
  }

  return res
}

module.exports = {
  "getPhoneNumberId": getPhoneNumberId,
  "createMessage": createMessage,
  "createVoicemail": createVoicemail,
  "getAllIntakeTickets": getAllIntakeTickets,
  "getChangedIntakeTickets": getChangedIntakeTickets
}
