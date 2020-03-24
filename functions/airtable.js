const functions = require('firebase-functions');
const Airtable = require('airtable');

const airtable = new Airtable({
  apiKey: functions.config().airtable.api_key,
});

const base = airtable.base(functions.config().airtable.base_id);

const INTAKE_CONTACTS = functions.config().airtable.intake_contacts_table;
const INTAKE_MESSAGES = functions.config().airtable.intake_messages_table;

module.exports = {

  getPhoneNumberId: (phoneNumber) => (
    base(INTAKE_CONTACTS).select({
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
  ),

  createMessage: (phoneNumberId, message) => (
    base(INTAKE_MESSAGES).create([
      {
        fields: {
          type: 'SMS',
          phone_number: [phoneNumberId],
          message: message,
        }
      },
    ])
  ),

  createVoicemail: (phoneNumberId, recordingUrl, message) => (
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
  )

};