#!/usr/bin/env node

const yargs = require('yargs');
const functions = require('firebase-functions');
const _ = require('lodash');
const twilio = require('twilio');
const Airtable = require('airtable');

const twilioClient = twilio(functions.config().twilio.sid, functions.config().twilio.auth_token);

const airtable = new Airtable({
  apiKey: functions.config().airtable.api_key,
});

const base = airtable.base(functions.config().airtable.base_id);

const { INTAKE_TABLE, VOLUNTEER_FORM_TABLE } = require('../airtable');

const ENGLISH = 'English';
const SPANISH = 'Spanish';

const LANGUAGES = [ ENGLISH, SPANISH ];

// Numbers in airtable may not be in a standard format
// or may have other text in the field
// assume all numbers are US numbers
const normalizeRecords = (defaultLanguage) => {
  return (record) => {
    const number = record.get('Phone Number') || '',
      digits = number.replace(/\D/g, ''),
      formatted = digits.length === 10 ? '+1' + digits : null;

    return {
      phoneNumber: formatted,
      language: record.get('Language') ? record.get('Language')[0] : defaultLanguage,
    };
  };
};

const getPhoneNumbers = async (table, fields, defaultLanguage) => {
  const records = await base(table).select({
    fields: fields
  }).all();

  return records.map(normalizeRecords(defaultLanguage))
    .filter((record) => { return record.phoneNumber !== null; });
};

/**
 * @param {string} defaultLanguage
 * @param {string[]} languages  If an airtable record has no language preference
 *        or a language preference other than the languages in this list, we will
 *        group it with the default language
 */
const getPhoneNumbersByLanguage = async (defaultLanguage, languages) => {
  const intakeRecords = await getPhoneNumbers(INTAKE_TABLE, ['Phone Number', 'Language'], defaultLanguage);

  // We don't have language prefs for volunteers
  // normalizedRecords sets languge to English
  const volunteerRecords = await getPhoneNumbers(VOLUNTEER_FORM_TABLE, ['Phone Number'], defaultLanguage);

  const withAvailableLanguagesOnly = _.chain(intakeRecords.concat(volunteerRecords)).map( (record) => {
    if (languages.includes(record.language)) {
      return record;
    }

    return _.assign(record, { language: defaultLanguage });
  }).uniqBy('phoneNumber').value();

  return _.groupBy(withAvailableLanguagesOnly, 'language');
};

const sendMassText = async (numbers, message) => {
  const bindings = numbers.map(number => {
    return JSON.stringify({ binding_type: 'sms', address: number });
  });
  const notificationOpts = {
    toBinding: bindings,
    body: message
  };

  const notification = await twilioClient.notify
    .services(functions.config().twilio.notify_service_sid)
    .notifications.create(notificationOpts);

  return notification.sid;
};

const main = async () => {
  const argv = yargs
    .usage('Usage: $0 [options] <en_message> [ <sp_message> ]')
    .version(false)
    .help('help').alias('help', 'h')
    .option('l', {
      description: 'live mode: actually send texts',
      alias: 'live',
      type: 'boolean',
      default: false
    })
    .example('./send-mass-text.js \'My English message\' \'My Spanish message\'', 'Send mass SMS to neighbors in English or Spanish. Messages must be in quotes.')
    .showHelpOnFail(false, 'whoops, something went wrong! run with --help')
    .demandCommand(1)
    .argv;

  // Useful for debugging, but we can't actually wait for user input
  // on the command line to confirm when running in firebase emulator
  // Zip languages with command line msg args in order
  // then strip undefined msgs
  const msgs = _.chain(LANGUAGES).zipObject(argv._).pickBy(_.identity).value();

  Object.entries(msgs).forEach(([language, msg]) => {
    console.log(language + ' message:');
    console.log(msg + '\n');
  });

  console.log('Fetching phone numbers from airtable...');
  const numberRecords = await getPhoneNumbersByLanguage(ENGLISH, LANGUAGES.slice(0, Object.keys(msgs).length));

  Object.entries(msgs).forEach(([language, msg]) => {
    let numbers = _.map(numberRecords[language], 'phoneNumber');
    if (argv.live === true) {
      console.log('Sending ' + language + ' message to ' + numbers.length + ' recipients.');
      let notification_id = sendMassText(numbers, msg);
      console.log(notification_id);
    } else {
      console.log('Would send ' + language + ' message to ' + numbers.length + ' recipients.');
    }
  });
};

(async () => {
  try {
    await main();
    console.log('Done!');
  } catch (error) {
    console.log(error);
  }
})();
