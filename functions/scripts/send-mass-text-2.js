#!/usr/bin/env node

/**
 * Interactive mass texting script
 * Usage:
 *    firebase emulators:exec "scripts/send-mass-text-2.js --contacts [full path to csv] [--excludes]"
 * 
 * Contacts CSV should contain at least one column with the header `phoneNumber`
 */

const EXCLUDE_GROUPS = {
  moved: 'moved away',
  no_voting: 'no voting messages',
  already_voted: 'already voted / has voting plan',
};
const DO_NOT_CONTACT = 'do not contact';

const fs = require('fs');
const path = require('path');
const functions = require('firebase-functions');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const csv = require('csv-parser');
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
} = require('../airtable');

const accountSid = functions.config().twilio.mass_messaging.sid;
const authToken = functions.config().twilio.mass_messaging.auth_token;
const notifySid = functions.config().twilio.mass_messaging.notify_sid;

const twilio = createTwilioClient(accountSid, authToken);

const argv = yargs(hideBin(process.argv))
  .option('contacts', {
    alias: 'c',
    describe: 'path to contacts CSV'
  })
  .option('excludes', {
    describe: 'enable excluding by tag'
  })
  .demandOption('contacts')
  .help()
  .argv;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readCSV(filename, headers) {
  return new Promise((resolve, reject) => {
    let rows = [];
    fs.createReadStream(filename)
      .pipe(csv(headers))
      .on('data', (data) => {
        rows.push(data);
      })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
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
const excludesPrompt = {
  type: 'multiselect',
  name: 'excludes',
  message: 'Exclude groups',
  instructions: false,
  hint: multiselectInstructions,
  onState: onState,
  choices: [
    { title: 'Moved away', value: EXCLUDE_GROUPS.moved },
    // { title: 'Already voted', value: EXCLUDE_GROUPS.already_voted },
    { title: 'No voting messages', value: EXCLUDE_GROUPS.no_voting },
  ],
};
const configPrompts = [
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
  {
    type: prev => prev.includes('\\n') ? 'confirm' : null,
    name: 'split',
    message: 'Split into multiple messages?',
    initial: true,
    onState: onState,
  }
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

    if (argv.excludes) {
      configPrompts.unshift(excludesPrompt);
    }

    const allPhoneNumbers = _.chain(await readCSV(argv.contacts, ['phoneNumber']))
      .map((value) => {
        const phoneNumber = parsePhoneNumberFromString(value.phoneNumber, 'US');
        if (phoneNumber) {
          return phoneNumber.format('E.164');
        } else {
          return null;
        }
      })
      .compact()
      .value();
    
    configPrompts.unshift({
      name: 'contacts',
      type: 'confirm',
      initial: true,
      message: 'Using contact list from file',
      onRender(kleur) {
        this.msg = kleur.reset('Using contact list from file ') + kleur.underline(path.basename(argv.contacts))
          + kleur.reset().cyan(`\n${allPhoneNumbers.length} phone numbers`) + '\n';
      },
    });

    const config = await prompts(configPrompts);

    const bodies = config.split ? config.body.split('\\n') : [config.body];

    const splitBody = splitter.split(config.body);
    const splitBodies = bodies.map(body => splitter.split(body));
    if (_.some(splitBodies, split => split.characterSet !== 'GSM')) {
      console.error('Message body is incompatible with GSM encoding. Please use the Message Segment Calculator: https://twiliodeved.github.io/message-segment-calculator/');
      return process.exit(1);
    }

    if (bodies.length > 1) {
      console.log(
        '\nMessage segments:\n' +
        splitBodies.map((split, index) => `Message ${index + 1}: ${split.parts.length} parts`).join('\n')
      );
    } else {
      console.log(`\nMessage segments: ${splitBody.parts.length}`);
    }

    let spinner = ora('Getting phone numbers').start();

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
    const testNotifications = [];
    for (const body of bodies) {
      await sleep(5000);
      const testNotification = await twilio.notify.services(notifySid).notifications.create({
        toBinding: testBindings,
        body: body,
      });
      testNotifications.push(testNotification);
    }

    spinner.succeed('Test sent');

    console.log('Test notification SIDs', _.map(testNotifications, 'sid'));

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
            kleur.reset().cyan(bodies.join('\n\n')),
          ].join('\n') + '\n';
        },
      }
    ];
    const finalConfirmation = await prompts(confirmationPrompts);
    if (!finalConfirmation.confirm) {
      console.error('Aborting');
      return process.exit(0);
    }

    const cancelTemplate = n => `Sending message, you have ${n} seconds to cancel`;
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
    const notifications = [];

    for (const body of bodies) {
      await sleep(5000);
      const notification = await twilio.notify.services(notifySid).notifications.create({
        toBinding: bindings,
        body: body,
      });
      notifications.push(notification);
    }

    spinner.succeed(`Message sent to ${phoneNumbers.length} phone numbers`);

    console.log('Notification SIDs', _.map(notifications, 'sid'));

    return process.exit(0);
  } catch (e) {
    console.error(e);
    return process.exit(1);
  }
})();
