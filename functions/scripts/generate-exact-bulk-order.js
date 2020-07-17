const _ = require('lodash');
const { argv } = require('yargs');

const {
  BULK_ORDER_TABLE,
  INTAKE_TABLE,
  ITEMS_BY_HOUSEHOLD_SIZE_TABLE,
  getAllRecords,
  getRecordsWithStatus,
  getBulkOrder,
  createRecord,
  deleteRecord,
} = require('../airtable');

async function main() {
  // TODO: Do real argument parsing.
  const deliveryDate = argv.deliveryDate;
  if (!deliveryDate) {
    throw new Error('must provide --deliveryDate=yyyy-mm-dd');
  }
  const intakeRecords = await getRecordsWithStatus(INTAKE_TABLE, 'Bulk Delivery Confirmed');

  console.log(`Found ${intakeRecords.length} bulk delivery confirmed tickets.`);

  const itemsByHouseholdSize = _.fromPairs(
    _.map(
      await getAllRecords(ITEMS_BY_HOUSEHOLD_SIZE_TABLE),
      ([, fields,]) => { return [fields.item, fields]; },
    ),
  );

  const itemToNumRequested = await getBulkOrder(intakeRecords);

  const bulkOrderRecords = _.filter(
    await getAllRecords(BULK_ORDER_TABLE),
    ([, fields,]) => {
      return fields.deliveryDate === deliveryDate;
    }
  );
  for (const [id,,] of bulkOrderRecords) {
    await deleteRecord(BULK_ORDER_TABLE, id);
  }

  const BUFFER_RATIO = 0.10;
  for (const [item, numRequested] of _.toPairs(itemToNumRequested)) {
    const buffer = _.ceil(numRequested * BUFFER_RATIO);
    await createRecord(
      BULK_ORDER_TABLE,
      {
        item: item,
        unit: (_.has(itemsByHouseholdSize, item)) ? _.get(itemsByHouseholdSize, item).unit : '?',
        quantity: numRequested + buffer,
        deliveryDate: deliveryDate,
      },
    );
  }
}

main().then(
  () => console.log('Done.')
).catch(
  (err) => console.log('Error!', { err: err })
);
