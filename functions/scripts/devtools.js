const functions = require('firebase-functions');
const Slack = require('slack');
const allSettled = require('promise.allsettled');
const _ = require('lodash');
const fs = require('fs');
const yargs = require('yargs');

allSettled.shim();

const {
  INBOUND_TABLE,
  INTAKE_TABLE,
  META_STORE_KEYS,
  REIMBURSEMENTS_TABLE,
  VOLUNTEER_FORM_TABLE,
  getChangedRecords,
  getMeta,
  getLastNonDuplicate,
  getRecord,
  getRecordsWithTicketID,
  getRecordsWithStatus,
  getTicketDueDate,
  getVolunteerSlackID,
  storeMeta,
  updateRecord,
  getVolunteerBySlackID,
} = require('../airtable');

const {
  INBOUND_STATUSES
} = require('../schema');

const {
  getIntakePostContent,
  getIntakePostDetails,
  getDeliveryDMContent,
  renderDeliveryDM,
  getTicketSummaryBlocks,
  getShoppingList,
  renderShoppingList,
} = require('../messages');

const bot = new Slack({ token: functions.config().slack.token });

async function getOneIntaketicket(ticket) {
  const records = await getRecordsWithTicketID(INTAKE_TABLE, ticket);
  if (records.length !== 1) {
    throw new Error(`Found ${records.length} records`);
  }
  return records[0];
}

const saveIntakeTicketInfo = async (ticket) => {
  const record = await getOneIntaketicket(ticket);
  fs.writeFileSync(`${ticket}.json`, JSON.stringify(record));
};

const showShoppingList = async (tickets) => {
  const records = await Promise.all(_.map(tickets, getOneIntaketicket));
  const email = await getShoppingList(records);
  console.log(renderShoppingList(email));
};

const sendDeliveryDM = async (ticket) => {
  const [, fields] = await getOneIntaketicket(ticket);
  const deliveryDMContent = await getDeliveryDMContent(fields);
  const renderedContent = renderDeliveryDM(fields.ticketID, deliveryDMContent, functions.config().slack.test_user_id);
  await bot.chat.postMessage(renderedContent);
  console.log(renderedContent);
};

const main = async () => {
  yargs
    .usage('Usage: $0 <cmd> [options]')
    .command({
      command: 'save-ticket <ticketID>',
      desc: 'Save an intake ticket record',
      handler: async (argv) => {
        await saveIntakeTicketInfo(argv.ticketID);
      }
    })
    .command({
      command: 'show-shopping-list [ticketIDs..]',
      desc: 'Show the shopping list for a group of tickets',
      handler: async (argv) => {
        await showShoppingList(argv.ticketIDs);
      }
    })
    .command({
      command: 'send-delivery-dm <ticketID>',
      desc: 'Send a test delivery DM for the given ticket to the slack.test_user_id',
      handler: async (argv) => {
        await sendDeliveryDM(argv.ticketID);
      }
    })
    .help('help').alias('help', 'h')
    .showHelpOnFail(true, 'whoops, something went wrong! run with --help')
    .version(false)
    .demandCommand(1)
    .argv;
};

main().catch(e => { console.error(e); process.exit(1); });
