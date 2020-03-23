const functions = require('firebase-functions');
const Airtable = require('airtable');

const airtable = new Airtable({
  apiKey: functions.config().airtable.api_key,
});

const base = airtable.base(functions.config().airtable.base_id);

const INTAKE_CONTACTS = functions.config().airtable.intake_contacts_table;
const INTAKE_MESSAGES = functions.config().airtable.intake_messages_table;

module.exports = {

  base: base,

  getPhoneNumberId: (phoneNumber) => (
    base(INTAKE_CONTACTS).select({
      maxRecords: 1,
      filterByFormula: `{phone_number} = "${phoneNumber}"`
    }).firstPage().then(records => {
      if (records[0]) {
        return records[0].id;
      } else {
        return base(INTAKE_CONTACTS).create([
          {
            fields: {
              phone_number: phoneNumber,
            }
          }
        ]).then(newRecords => {
          return newRecords[0].id;
        });
      }
    })
  ),

  createMessage: (phoneNumberId, message) => (
    base(INTAKE_MESSAGES).create([
      {
        fields: {
          phone_number: [phoneNumberId],
          message: message,
        }
      },
    ])
  ),

};