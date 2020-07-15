const functions = require('firebase-functions');
const Slack = require('slack');
const allSettled = require('promise.allsettled');
const _ = require('lodash');
const fs = require('fs');
const {argv} = require('yargs');

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
} = require('../airtable');

const {
  INBOUND_STATUSES
} = require('../schema');

const {
  getIntakePostContent,
  getIntakePostDetails,
  getDeliveryDMContent,
  getTicketSummaryBlocks,
  getShoppingList,
  renderShoppingList,
} = require('../messages');

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
  const records = await Promise.all(_.map(tickets.split(','), getOneIntaketicket));
  const email = await getShoppingList(records);
  console.log(renderShoppingList(email));
};

const main = async () => {
  if (argv.saveTicket !== undefined) {
    await saveIntakeTicketInfo(argv.saveTicket);
  } else if (argv.showShoppingList !== undefined) {
    await showShoppingList(argv.showShoppingList);
  } else {
    console.error('no arguments matched TODO help text');
  }
};

main().catch(e => { console.error(e); process.exit(1); });
