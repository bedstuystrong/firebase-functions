#!/usr/bin/env node

const USE_EXCLUDES = false;

const TARGETS = {
  tickets: {
    key: 'tickets',
    get: async () => await getPhoneNumbers(INTAKE_TABLE, { Status: 'Complete', Neighborhood: 'SE' }),
  },
  volunteers: {
    key: 'volunteers',
    get: async () => await getPhoneNumbers(VOLUNTEER_FORM_TABLE),
  },
};
const EXCLUDE_GROUPS = {
  moved: 'moved away',
  no_voting: 'no voting messages',
  already_voted: 'already voted / has voting plan',
};
const DO_NOT_CONTACT = 'do not contact';

const functions = require('firebase-functions');
const _ = require('lodash');
const prompts = require('prompts');
const ora = require('ora');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const createTwilioClient = require('twilio');
const splitter = require('split-sms');

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
  console.log('lookupPhoneType', phoneNumber)
  try {
    const response = await twilio.lookups.v1.phoneNumbers(phoneNumber).fetch({ type: 'carrier' });
    await sleep(100);
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
  if (fields.neighborhood !== 'SE') console.log(fields.neighborhood)
  const phoneNumber = fields.phoneNumber;
  if (!phoneNumber) return null;
  const parsed = parsePhoneNumberFromString(phoneNumber.split('/')[0], 'US');
  if (!parsed) return null;
  return parsed.format('E.164');
};

const getPhoneNumbers = async (table, filter = {}) => {
  const clauses = _.entries(filter).map(([key, value]) => `{${key}} = "${value}"`);
  const records = await getAllRecords(table, {
    fields: ['Phone Number', ..._.keys(filter)],
    filterByFormula: `AND(${clauses.join(', ')})`,
  });
  return _.uniq(_.compact(records.map(extractNumber)));
};

const getPhoneNumberMeta = async () => {
  return await getAllRecords(PHONE_NUMBERS_TABLE);
};

const createBindings = numbers => numbers.map((number) => JSON.stringify({
  binding_type: 'sms',
  address: number,
}));

const rejectByTag = tag => meta => (meta.tags && meta.tags.includes(tag));

const onState = (state) => {
  if (state.aborted) throw new Error();
};

const multiselectInstructions = 'space to select, enter to submit';
const configPrompts = [
  {
    type: 'multiselect',
    name: 'targets',
    message: 'Send to',
    instructions: false,
    hint: multiselectInstructions,
    onState: onState,
    choices: [
      { title: 'Delivery recipients', value: TARGETS.tickets.key },
      { title: 'Volunteers', value: TARGETS.volunteers.key },
    ],
    min: 1,
  },
  {
    type: USE_EXCLUDES ? 'multiselect' : null,
    name: 'excludes',
    message: 'Exclude groups',
    instructions: false,
    hint: multiselectInstructions,
    onState: onState,
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
    onState: onState,
    onRender(kleur) {
      this.msg = [
        kleur.bold().white('Message body'),
        kleur.reset().gray('Make sure to run the message through'),
        kleur.reset().underline().gray('https://twiliodeved.github.io/message-segment-calculator/'),
      ].join('\n') + '\n';
    },
  },
];

const testPrompts = [
  {
    type: 'list',
    name: 'numbers',
    message: 'Test phone numbers',
    initial: '',
    separator: ',',
    onState: onState,
    format: (value) => value.map(v => parsePhoneNumberFromString(v, 'US').format('E.164')),
  },
  {
    type: 'confirm',
    name: 'confirm',
    message: prev => `Send test to ${prev.join(', ')}?`,
    initial: false,
    onState: onState,
  }
];

(async () => {
  try {
    console.log('\n');

    const config = await prompts(configPrompts);

    const splitBody = splitter.split(config.body);
    if (splitBody.characterSet !== 'GSM') {
      console.error('Message body is incompatible with GSM encoding. Please use the Message Segment Calculator: https://twiliodeved.github.io/message-segment-calculator/');
      return process.exit(1);
    }

    console.log(`\nMessage segments: ${splitBody.parts.length}`);

    let spinner = ora('Getting phone numbers').start();

    let allPhoneNumbers = _.intersection(...await Promise.all(
      config.targets.map((async targetKey => await TARGETS[targetKey].get()))
    ));

    const phoneNumberMeta = (await getPhoneNumberMeta()).map(([, fields,]) => fields);

    spinner.text = 'Updating phone numbers';

    let phoneNumbers = _.compact(await Promise.all(
      allPhoneNumbers.map(async (number) => {
        const meta = _.find(phoneNumberMeta, ['phoneNumberE164', number]);

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
          } else {
            return null;
          }
        }
      })
    ));

    spinner.text = 'Filtering phone numbers';
    
    phoneNumbers = _.chain(phoneNumbers)
      .filter(['type', 'mobile'])
      .reject(rejectByTag(DO_NOT_CONTACT));

    if (config.excludes) {
      config.excludes.forEach((exclude) => {
        phoneNumbers.reject(rejectByTag(exclude));
      });
    }

    phoneNumbers = phoneNumbers.value();

    spinner.succeed(`${phoneNumbers.length} phone numbers`);

    let testRun = await prompts(testPrompts);

    while (!testRun.confirm) {
      testRun = await prompts(testPrompts);
    }

    spinner = ora('Sending test').start();

    const testBindings = createBindings(testRun.numbers);

    const testNotification = await twilio.notify.services(notifySid).notifications.create({
      toBinding: testBindings,
      body: config.body,
    });

    spinner.succeed('Test sent');

    console.log('Test notification SID', testNotification.sid);

    const confirmationPrompts = [
      {
        type: 'confirm',
        name: 'confirm',
        message: '',
        initial: false,
        onState: onState,
        onRender(kleur) {
          this.msg = [
            kleur.bold().white(`Send the following message to ${phoneNumbers.length} phone numbers?`),
            kleur.reset().cyan(config.body),
          ].join('\n') + '\n';
        },
      }
    ];
    const finalConfirmation = await prompts(confirmationPrompts);
    if (!finalConfirmation.confirm) {
      console.error('Aborting');
      return process.exit(0);
    }

    const cancelTemplate = n => `Sending mesaage, you have ${n} seconds to cancel`;
    spinner = ora(cancelTemplate(5)).start();
    await sleep(1000);
    spinner.text = cancelTemplate(4);
    await sleep(1000);
    spinner.text = cancelTemplate(3);
    await sleep(1000);
    spinner.text = cancelTemplate(2);
    await sleep(1000);
    spinner.text = cancelTemplate(1);
    await sleep(1000);
    spinner.text = 'Sending message';

    const bindings = createBindings(phoneNumbers.map(meta => meta.phoneNumberE164));

    const notification = await twilio.notify.services(notifySid).notifications.create({
      toBinding: bindings,
      body: config.body,
    });

    spinner.succeed(`Message sent to ${phoneNumbers.length} phone numbers`);

    console.log('Notification SID', notification.sid);

    return process.exit(0);
  } catch (e) {
    console.error(e);
    return process.exit(1);
  }
})();
