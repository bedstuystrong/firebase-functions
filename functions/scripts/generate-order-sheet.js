const _ = require('lodash');

const {
  BULK_ORDER_TABLE,
  INTAKE_TABLE,
  ITEMS_BY_HOUSEHOLD_SIZE_TABLE,
  createRecord,
  deleteRecord,
  getAllRecords,
  getBulkOrder,
} = require('../airtable');

async function main() {
  // TODO : make household size a CLI argument
  const MAX_HOUSEHOLD_SIZE = 6;
  const MAX_AGE_DAYS = 21;
  const MIN_NUM_ITEMS = 5;

  // Date when the bulk deliveries will happen
  const DELIVERY_DATE = new Date('2020-07-18');
  // The number of households we are bulk purchasing for
  const NUM_HOUSEHOLDS = 60;
  // How much extra to order just in case!
  const BUFFER_RATIO = 0.15;

  console.log('Generating the order sheet...');
  const allRecords = await getAllRecords(INTAKE_TABLE);

  const sampledRecords = _.filter(
    allRecords,
    ([, fields,]) => {
      const MILLIS_IN_DAY = 1000 * 60 * 60 * 24;
      const ticketAgeDays = (Date.now() - (new Date(fields.dateCreated)).getTime()) / MILLIS_IN_DAY;

      return (
        !_.isNull(fields.foodOptions) &&
        fields.foodOptions.length >= MIN_NUM_ITEMS &&
        fields.householdSize <= MAX_HOUSEHOLD_SIZE &&
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
  console.log(`Generating an order for ${NUM_HOUSEHOLDS} households (with approximately ${_.round(NUM_HOUSEHOLDS * avgHouseholdSize)} people)`);

  const itemsByHouseholdSize = _.fromPairs(
    _.map(
      await getAllRecords(ITEMS_BY_HOUSEHOLD_SIZE_TABLE),
      ([, fields,]) => { return [fields.item, fields]; },
    ),
  );

  const itemToNumRequested = await getBulkOrder(sampledRecords);

  const itemAndOrderQuantity = _.map(
    _.toPairs(itemToNumRequested),
    ([item, numRequested]) => {
      return [
        item,
        // - Adjust the sampled requested with the number of households we are purchasing for
        // - Add a buffer so we don't under order
        // - Round to the nearest integer
        _.round(
          (
            numRequested * (NUM_HOUSEHOLDS / sampledRecords.length)
          ) * (1 + BUFFER_RATIO),
          0,
        ),
      ];
    },
  );

  // Add the new bulk order
  for (const [item, numRequested] of itemAndOrderQuantity) {
    await createRecord(
      BULK_ORDER_TABLE,
      {
        item: item,
        unit: (_.has(itemsByHouseholdSize, item)) ? _.get(itemsByHouseholdSize, item).unit : '?',
        quantity: numRequested,
        deliveryDate: DELIVERY_DATE,
      },
    );
  }
}

main().then(
  () => console.log('Done.')
).catch(
  (err) => console.log('Error!', { err: err })
);
