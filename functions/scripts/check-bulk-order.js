const _ = require('lodash');

const {
  BULK_ORDER_TABLE,
  INTAKE_TABLE,
  getAllRecords,
  getRecordsWithStatus,
  getBulkOrder,
} = require('../airtable');

async function main() {
  const intakeRecords = await getRecordsWithStatus(INTAKE_TABLE, 'Bulk Delivery Confirmed');

  console.log(`Found ${intakeRecords.length} bulk delivery confirmed tickets.`);

  const itemToNumRequested = await getBulkOrder(intakeRecords);

  const bulkOrderRecords = await getAllRecords(BULK_ORDER_TABLE);
  const itemToNumOrdered = _.fromPairs(
    _.map(
      bulkOrderRecords,
      ([, fields,]) => { return [fields.item, fields.quantity]; },
    )
  );

  // item => ordered - requested
  const delta = _.fromPairs(
    _.filter(
      _.map(
        _.union(
          _.keys(itemToNumRequested),
          _.keys(itemToNumOrdered),
        ),
        (item) => {
          return [item, _.get(itemToNumOrdered, item, 0) - _.get(itemToNumRequested, item, 0)];
        },
      ),
      ([, diff]) => { return diff !== 0; },
    )
  );

  console.log(`Found ${delta.length} items with mismatched quantities.`);

  if (delta.length !== 0) {
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
