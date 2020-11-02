#!/usr/bin/env node

const functions = require('firebase-functions');
const _ = require('lodash');
const prompts = require('prompts');
const ora = require('ora');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const createTwilioClient = require('twilio');

const {
  getAllRecords,
  createRecord,
  PHONE_NUMBERS_TABLE,
  INTAKE_TABLE,
  VOLUNTEER_FORM_TABLE,
} = require('../airtable');

const accountSid = functions.config().twilio.mass_messaging.sid;
const authToken = functions.config().twilio.mass_messaging.auth_token;
const notifySid = functions.config().twilio.mass_messaging.notify_sid;

const twilio = createTwilioClient(accountSid, authToken);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const lookupPhoneType = async (phoneNumber) => {
  try {
    const response = await twilio.lookups.v1.phoneNumbers(phoneNumber).fetch({ type: 'carrier' });
    if (response.carrier) {
      return response.carrier.type;
    } else {
      return null;
    }
  } catch (error) {
    console.log('lookup failed', phoneNumber, error);
    return null;
  }
};

const extractNumber = ([, fields, ]) => {
  const phoneNumber = fields.phoneNumber;
  if (!phoneNumber) return null;
  const parsed = parsePhoneNumberFromString(phoneNumber.split('/')[0], 'US');
  if (!parsed) return null;
  return parsed.format('E.164');
};

const getPhoneNumbers = async (table, filter = {}) => {
  console.log({filter})
  const records = await getAllRecords(table, {
    fields: ['Phone Number'],
    filterByFormula: _.entries(filter).map(([key, value]) => `{${key}} = "${value}"`),
  });
  return _.uniq(_.compact(records.map(extractNumber)));
};

const getPhoneNumberMeta = async () => {
  return await getAllRecords(PHONE_NUMBERS_TABLE);
};

const TARGETS = {
  tickets: {
    key: 'tickets',
    get: async () => await getPhoneNumbers(INTAKE_TABLE, { Status: 'Complete' }),
  },
  volunteers: {
    key: 'volunteers',
    get: async () => await getPhoneNumbers(VOLUNTEER_FORM_TABLE),
  },
}
const EXCLUDE_GROUPS = {
  moved: 'moved away',
  no_voting: 'no voting messages',
  already_voted: 'already voted / has voting plan',
};

(async () => {
  console.log('\n');
  const multiselectInstructions = 'space to select, enter to submit';

  const config = await prompts([
    {
      type: 'multiselect',
      name: 'targets',
      message: 'Send to',
      instructions: false,
      hint: multiselectInstructions,
      choices: [
        { title: 'Delivery recipients', value: TARGETS.tickets.key },
        { title: 'Volunteers', value: TARGETS.volunteers.key },
      ],
      min: 1,
    },
    {
      type: 'multiselect',
      name: 'excludes',
      message: 'Exclude groups',
      instructions: false,
      hint: multiselectInstructions,
      choices: [
        { title: 'Moved away', value: EXCLUDE_GROUPS.moved },
        { title: 'Already voted', value: EXCLUDE_GROUPS.already_voted },
        { title: 'No voting messages', value: EXCLUDE_GROUPS.no_voting },
      ],
    },
    {
      type: 'text',
      name: 'body',
      message: 'Message body',
      onRender(kleur) {
        this.msg = [
          kleur.bold().white('Message body'),
          kleur.reset().gray('Make sure to run the message through'),
          kleur.reset().underline().gray('https://twiliodeved.github.io/message-segment-calculator/'),
        ].join('\n') + '\n';
      }
    },
  ]);

  console.log({config})

  try {

    const spinner = ora('Getting phone numbers').start();

    let allPhoneNumbers = _.intersection(...await Promise.all(
      config.targets.map((async targetKey => await TARGETS[targetKey].get()))
    ));

    spinner.text = 'Updating phone numbers';

    const phoneNumberMeta = (await getPhoneNumberMeta()).map(([, fields,]) => fields);

    let phoneNumbers = _.compact(await Promise.all(
      allPhoneNumbers.map(async (number) => {
        const meta = _.find(phoneNumberMeta, ['phoneNumber', number]);

        if (meta) {
          return meta;
        } else {
          const type = await lookupPhoneType(number);
          if (type) {
            const [, fields] = await createRecord(PHONE_NUMBERS_TABLE, {
              phoneNumberE164: number,
              type: type,
            });
            return fields;
          }
        }
      })
    ));

    phoneNumbers = _.filter(phoneNumbers, ['type', 'mobile']);

    spinner.text = 'phoneNumbers.length: ' + phoneNumbers.length

    spinner.text = 'haha code machine go brrr'

    return process.exit(0);
  } catch (e) {
    console.error(e);
    return process.exit(1);
  }
})();
