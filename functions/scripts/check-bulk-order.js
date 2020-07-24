const _ = require('lodash');
const { argv } = require('yargs');

const {
  BULK_ORDER_TABLE,
  INTAKE_TABLE,
  getAllRecords,
  getRecordsWithStatus,
  getBulkOrder,
} = require('../airtable');

async function main() {
  // TODO: Do real argument parsing.
  const deliveryDate = argv.deliveryDate;
  if (!deliveryDate) {
    throw new Error('must provide --deliveryDate=yyyy-mm-dd');
  }
  const intakeRecords = await getRecordsWithStatus(INTAKE_TABLE, 'Bulk Delivery Confirmed');

  console.log(`Found ${intakeRecords.length} bulk delivery confirmed tickets.`);

  const itemToNumRequested = await getBulkOrder(intakeRecords);

  const bulkOrderRecords = _.filter(
    await getAllRecords(BULK_ORDER_TABLE),
    ([, fields,]) => {
      return fields.deliveryDate === deliveryDate;
    }
  );
  const itemToNumOrdered = _.fromPairs(
    _.map(
      bulkOrderRecords,
      ([, fields,]) => { return [fields.item, fields.quantity]; },
    )
  );

  const allItems = _.union(_.keys(itemToNumRequested), _.keys(itemToNumOrdered));
  
  const getDiffForItem = (item) => {
    return [item, _.get(itemToNumOrdered, item, 0) - _.get(itemToNumRequested, item, 0)];
  };

  // item => ordered - requested
  const delta = _.fromPairs(
    _.filter(
      _.map(allItems, getDiffForItem),
      ([, diff]) => { return diff !== 0; },
    )
  );

  console.log(`Found ${_.keys(delta).length} items with mismatched quantities.`);

  if (_.keys(delta).length !== 0) {
    console.log('Mismatched Items and Differences (num ordered - num requested)');
    _.forIn(
      delta,
      (diff, item) => {
        console.log(`   - ${item}: ${diff}`);
      },
    );
  }
}

main().then(
  () => console.log('Done.')
).catch(
  (err) => console.log('Error!', { err: err })
);
