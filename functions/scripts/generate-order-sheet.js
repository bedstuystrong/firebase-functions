const _ = require('lodash');
const yargs = require('yargs');
const moment = require('moment');

const {
  BULK_ORDER_TABLE,
  INTAKE_TABLE,
  ITEMS_BY_HOUSEHOLD_SIZE_TABLE,
  createRecord,
  deleteRecord,
  getAllRecords,
  getBulkOrder,
  getRecordsWithStatus,
} = require('../airtable');

async function main() {
  const { argv } = yargs
    .command('predict', 'Predict an upcoming order based on past tickets', {
      'max-household-size': {
        default: 6,
        describe: 'For prediction, sample historical tickets with at most this many members',
        type: 'number'
      },
      'num-households': {
        default: 80,
        describe: 'Predict this many deliveries',
        type: 'number'
      }
    })
    .command('finalize', 'Generate final order sheet from confirmed bulk delivery tickets')
    .option('delivery-date', {
      coerce: (x) => new Date(x),
      demandOption: true,
      describe: 'Date of scheduled delivery (yyyy-mm-dd format)',
    })
    .option('buffer-ratio', {
      default: 0.15,
      describe: 'Pad the order by this fraction above requested items',
      type: 'number'
    })
    .boolean('dry-run')
    .demandCommand(1, 1, 'Please provide a command', 'Only one command at a time');

  console.log('Generating the order sheet...');

  const itemToNumRequested = argv._[0] === 'predict' ? (
    await predictOrder(argv)
  ) : (argv._[0] === 'finalize' ? (
    await finalizeOrder(argv)
  ) : (() => { throw new Error(`Unknown command ${argv._}`); })());

  const paddedItemToNumRequested = padOrder(itemToNumRequested, argv.bufferRatio);

  const bulkOrderRows = await generateBulkOrderRows(paddedItemToNumRequested, argv.deliveryDate);

  if (argv.dryRun) {
    console.log(bulkOrderRows);
  } else {
    await populateBulkOrder(bulkOrderRows, argv.deliveryDate);
  }
}

const predictOrder = async ({ numHouseholds, maxHouseholdSize }) => {
  const MAX_AGE_DAYS = 21;
  const MIN_NUM_ITEMS = 5;

  const allRecords = await getAllRecords(INTAKE_TABLE);

  const sampledRecords = _.filter(
    allRecords,
    ([, fields,]) => {
      const MILLIS_IN_DAY = 1000 * 60 * 60 * 24;
      const ticketAgeDays = (Date.now() - (new Date(fields.dateCreated)).getTime()) / MILLIS_IN_DAY;

      return (
        !_.isNull(fields.foodOptions) &&
        fields.foodOptions.length >= MIN_NUM_ITEMS &&
        fields.householdSize <= maxHouseholdSize &&
        _.isNull(fields.items) &&
        ticketAgeDays <= MAX_AGE_DAYS
      );
    }
  );

  console.log(`Found ${sampledRecords.length} records to use for estimating orders.`);

  const sampledNumPeople = _.sum(
    _.map(
      sampledRecords,
      ([, fields,]) => {
        return fields.householdSize;
      }
    )
  );
  const avgHouseholdSize = sampledNumPeople / sampledRecords.length;

  console.log(`The average household size is ${_.round(avgHouseholdSize)}`);
  console.log(`Generating an order for ${numHouseholds} households (with approximately ${_.round(numHouseholds * avgHouseholdSize)} people)`);

  const itemToNumRequested = await getBulkOrder(sampledRecords);

  const scaleToNumOrders = (numRequested) => {
    // - Adjust the samples requested with the number of households we are purchasing for
    return numRequested * (numHouseholds / sampledRecords.length);
  };

  const itemAndOrderQuantity = _.map(
    _.toPairs(itemToNumRequested),
    ([item, numRequested]) => {
      return [item, scaleToNumOrders(numRequested)];
    },
  );

  return itemAndOrderQuantity;
};

const finalizeOrder = async () => {
  const intakeRecords = await getRecordsWithStatus(INTAKE_TABLE, 'Bulk Delivery Confirmed');

  console.log(`Found ${intakeRecords.length} bulk delivery confirmed tickets.`);

  return _.toPairs(await getBulkOrder(intakeRecords));
};

const padOrder = (itemToNumRequested, bufferRatio) => {
  const padOrderSize = (numRequested) => {
    // - Add a buffer so we don't under order
    const bufferedNumRequested = numRequested * (1 + bufferRatio);
    // - Round up to the nearest integer
    return _.ceil(bufferedNumRequested);
  };

  return _.map(
    itemToNumRequested,
    ([item, numRequested]) => {
      return [item, padOrderSize(numRequested)];
    },
  );
};

const generateBulkOrderRows = async (itemAndOrderQuantity, deliveryDate) => {
  const itemsByHouseholdSize = _.fromPairs(
    _.map(
      await getAllRecords(ITEMS_BY_HOUSEHOLD_SIZE_TABLE),
      ([, fields,]) => { return [fields.item, fields]; },
    ),
  );

  return _.map(itemAndOrderQuantity, ([item, numRequested]) => {
    return {
      item: item,
      unit: (_.has(itemsByHouseholdSize, item)) ? _.get(itemsByHouseholdSize, item).unit : '?',
      quantity: numRequested,
      deliveryDate: deliveryDate,
    };
  });
};

const populateBulkOrder = async (bulkOrderRows, deliveryDate) => {
  // Delete old records for this delivery date
  const oldBulkOrderRecords = _.filter(
    await getAllRecords(BULK_ORDER_TABLE),
    ([, fields,]) => {
      return fields.deliveryDate === moment(deliveryDate).utc().format('YYYY-MM-DD');
    }
  );
  await Promise.all(_.map(oldBulkOrderRecords, async ([id,,]) => { await deleteRecord(BULK_ORDER_TABLE, id); }));

  // Add the new bulk order
  await Promise.all(_.map(bulkOrderRows, async (row) => { await createRecord(BULK_ORDER_TABLE, row); }));
};

main().then(
  () => console.log('Done.')
).catch(
  (err) => console.log('Error!', { err: err })
);
