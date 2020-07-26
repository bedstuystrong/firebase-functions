const functions = require('firebase-functions');

const _ = require('lodash');
const moment = require('moment');

const Airtable = require('airtable');

const {
  BULK_ORDER_SCHEMA,
  BULK_DELIVERY_ROUTES_SCHEMA,
  INBOUND_SCHEMA,
  INBOUND_STATUSES,
  INTAKE_SCHEMA,
  ITEMS_BY_HOUSEHOLD_SIZE_SCHEMA,
  META_STORE_KEYS,
  REIMBURSEMENT_SCHEMA,
  VOLUNTEER_SCHEMA,
  denormalize,
  normalize,
} = require('./schema');

const IS_PROD = functions.config().environment.type === 'prod';

const airtable = new Airtable({
  apiKey: functions.config().airtable.api_key,
});

const base = airtable.base(functions.config().airtable.base_id);

const INBOUND_TABLE = functions.config().airtable.inbound_table;
const VOLUNTEER_FORM_TABLE = functions.config().airtable.volunteers_table;
const INTAKE_TABLE = functions.config().airtable.intake_table;
const REIMBURSEMENTS_TABLE = functions.config().airtable.reimbursements_table;
const META_TABLE = functions.config().airtable.meta_table;
const ITEMS_BY_HOUSEHOLD_SIZE_TABLE = functions.config().airtable
  .items_by_household_size_table;
const BULK_ORDER_TABLE = functions.config().airtable.bulk_order_table;
const BULK_DELIVERY_ROUTES_TABLE = functions.config().airtable
  .bulk_delivery_routes_table;

const TABLE_SCHEMAS = {
  [INBOUND_TABLE]: INBOUND_SCHEMA,
  [INTAKE_TABLE]: INTAKE_SCHEMA,
  [VOLUNTEER_FORM_TABLE]: VOLUNTEER_SCHEMA,
  [REIMBURSEMENTS_TABLE]: REIMBURSEMENT_SCHEMA,
  [ITEMS_BY_HOUSEHOLD_SIZE_TABLE]: ITEMS_BY_HOUSEHOLD_SIZE_SCHEMA,
  [BULK_ORDER_TABLE]: BULK_ORDER_SCHEMA,
  [BULK_DELIVERY_ROUTES_TABLE]: BULK_DELIVERY_ROUTES_SCHEMA,
};

/* GENERAL */

function normalizeRecords(table) {
  const schema = TABLE_SCHEMAS[table];
  return function normalizeRecord(record) {
    // TODO make this an object
    return [
      record.id,
      normalize(record.fields, schema),
      record.fields._meta ? JSON.parse(record.fields._meta) : {},
    ];
  };
}

async function getAllRecords(table) {
  const records = await base(table).select().all();
  return records.map(normalizeRecords(table));
}

async function getRecord(table, recordID) {
  const rec = await base(table).find(recordID);
  return normalizeRecords(table)(rec);
}

/**
 * Get records from a table, filtering based on the schema.
 *
 * For the filter, use keys that match the schema for the table you're querying.
 *
 * @example
 * // Gets bulk delivery routes for July 25th
 * getRecordsWithFilter(BULK_DELIVERY_ROUTES_TABLE, { deliveryDate: new Date("2020-07-25") })
 *
 * @param {string} table The table to query.
 * @param {Object.<string, any>} filter The filter to apply, keys should be columns defined in the schema for `table`.
 */
async function getRecordsWithFilter(table, filter) {
  const schema = TABLE_SCHEMAS[table];
  const clauses = _.map(_.entries(filter), ([key, value]) => {
    const tableKey = schema[key];
    if (value instanceof Date) {
      const yyyymmdd = moment(value).utc().format('YYYY-MM-DD');
      return `DATESTR({${tableKey}}) = "${yyyymmdd}"`;
    } else {
      return `{${tableKey}} = "${value}"`;
    }
  });
  const filterByFormula = _.join(clauses, ' AND ');
  const query = base(table).select({ filterByFormula });
  const records = await query.all();
  return records.map(normalizeRecords(table));
}

async function getRecordsWithTicketID(table, ticketID) {
  return await getRecordsWithFilter(table, { ticketID });
}

async function getRecordsWithStatus(table, status) {
  return await getRecordsWithFilter(table, { status });
}

// Returns only intake tickets whose status has changed since we last checked. If `includeNullStatus`
// is true, we will include records without a status.
//
// NOTE that we accomplish this by updating a `_meta` field in the record's airtable entry
// NOTE that this function will only work if the table has a `Status` field
async function getChangedRecords(table, includeNullStatus = false) {
  // Get all tickets with updated statuses
  const allRecords = await getAllRecords(table);
  return allRecords.filter(([, fields, meta]) => {
    if (_.isNull(fields.status) && Object.keys(meta).length === 0) {
      return includeNullStatus;
    } else if (Object.keys(meta).length === 0) {
      // This is a non-null status, and we haven't written down our meta yet
      return true;
    } else {
      return fields.status !== meta.lastSeenStatus;
    }
  });
}

async function updateRecord(table, id, delta, meta) {
  let fields = denormalize(delta, TABLE_SCHEMAS[table]);

  if (meta) {
    fields._meta = JSON.stringify(meta);
  }

  return normalizeRecords(table)(await base(table).update(id, fields));
}

async function createRecord(table, fields, meta) {
  let denormalizedFields = denormalize(fields, TABLE_SCHEMAS[table]);

  if (meta) {
    denormalizedFields._meta = JSON.stringify(meta);
  }

  return normalizeRecords(table)(await base(table).create(denormalizedFields));
}

async function deleteRecord(table, id) {
  await base(table).destroy(id);
}

/* INBOUND */

function createMessage(phoneNumber, message) {
  // NOTE that we set a `null` status for the record, and let the `onNewInbound` poll function set the status
  const fields = denormalize(
    {
      method: 'Text Message',
      phoneNumber: phoneNumber,
      message: message,
    },
    INBOUND_SCHEMA
  );
  return base(INBOUND_TABLE).create([{ fields }]);
}

function createVoicemail(phoneNumber, recordingUrl, message) {
  // NOTE that we set a `null` status for the record, and let the `onNewInbound` poll function set the status
  const fields = denormalize(
    {
      method: 'Phone Call',
      phoneNumber: phoneNumber,
      message: message,
      voicemailRecording: recordingUrl,
    },
    INBOUND_SCHEMA
  );
  return base(INBOUND_TABLE).create([{ fields }]);
}

// This function retrieves the last non-duplicate ticket for a phone number, which is used for
// handling multiple inbound messages from the same phone number.
async function getLastNonDuplicate(phoneNumber) {
  const query = base(INBOUND_TABLE).select({
    filterByFormula: `{${INBOUND_SCHEMA.phoneNumber}} = "${phoneNumber}"`,
  });
  const records = (await query.all()).map(normalizeRecords(INBOUND_TABLE));

  // NOTE that we return `null` if there were no prior inbound records
  return (
    _.last(
      _.filter(
        _.sortBy(records, ([, fields]) => {
          return new Date(fields.dateCreated);
        }),
        ([, fields]) => {
          return (
            !_.isNull(fields.status) &&
            fields.status !== INBOUND_STATUSES.duplicate
          );
        }
      )
    ) || null
  );
}

/* VOLUNTEER */

async function getVolunteerSlackID(volunteerID) {
  // Ensures that all DMs go to the test user
  if (!IS_PROD) {
    return functions.config().slack.test_user_id;
  }

  const rec = await base(VOLUNTEER_FORM_TABLE).find(volunteerID);
  return normalize(rec.fields, VOLUNTEER_SCHEMA).slackUserID;
}

/* INTAKE */

// Returns the number of days left to complete the ticket
// TODO : come back and make sure the math here represents what we want
function getTicketDueIn(fields) {
  return Math.round(
    (getTicketDueDate(fields) - Date.now()) / (1000 * 60 * 60 * 24)
  );
}

// Returns the number of days left to complete the ticket
function getTicketDueDate(fields) {
  const NEED_IMMEDIACY_TO_DAYS = {
    'Before the end of the day': 1,
    'Within a day or two': 2,
    'Within a week': 7,
    'As soon as possible': 0,
  };

  const dateCreated = new Date(fields.dateCreated);
  const daysAllotted = NEED_IMMEDIACY_TO_DAYS[fields.timeline];

  return new Date(dateCreated.getTime() + daysAllotted * (1000 * 60 * 60 * 24));
}

/* BULK ORDER */

async function getItemsByHouseholdSize() {
  return _.fromPairs(
    _.map(await getAllRecords(ITEMS_BY_HOUSEHOLD_SIZE_TABLE), ([, fields]) => {
      return [fields.item, fields];
    })
  );
}

// Returns a bulk order for the provided intake records.
//
// tl;dr:
// - Get item and household size to unit and quantity mapping from airtable
// - Aggregate the structured items from the provided intake records
// - Adjust structured items for household size
// - Generate item to quanitity mapping
async function getBulkOrder(records) {
  const itemsByHouseholdSize = await getItemsByHouseholdSize();

  const failedToLookup = [];

  const getItemQuantity = (item, householdSize) => {
    if (!_.has(itemsByHouseholdSize, item)) {
      failedToLookup.push(item);
      return 0;
    }
    return itemsByHouseholdSize[item][householdSize];
  };

  const itemToNumRequested = _.reduce(
    records,
    (acc, [, fields]) => {
      const order = _.fromPairs(
        _.map(fields.foodOptions, (item) => {
          return [
            item,
            _.get(acc, item, 0) + getItemQuantity(item, fields.householdSize),
          ];
        })
      );
      return _.assign(acc, order);
    },
    {}
  );

  if (failedToLookup.length !== 0) {
    // throw Error(`Failed to get item by household size for: ${_.join(_.uniq(failedToLookup))}`);
    console.error(
      `Failed to get item by household size for: ${_.join(
        _.uniq(failedToLookup)
      )}`
    );
  }

  return itemToNumRequested;
}

/**
 * Get a mapping from item name to the amount we ordered this week.
 * @param {Date} deliveryDate Date this bulk delivery will go out.
 * @returns {Promise<Object.<string, number>>} Map from item name to quantity available.
 */
async function getItemToNumAvailable(deliveryDate) {
  const bulkOrderRecords = await getRecordsWithFilter(BULK_ORDER_TABLE, { deliveryDate });
  return _.fromPairs(
    _.map(bulkOrderRecords, ([, fields]) => {
      return [fields.item, fields.quantity];
    })
  );
}

/**
 * Get all Bulk Delivery Route records for this week.
 * @param {Date} deliveryDate Date this bulk delivery will go out.
 * @return {Promise<[string, Object, Object][]>} List of route records.
 */
async function getAllRoutes(deliveryDate) {
  const allRoutes = await getRecordsWithFilter(BULK_DELIVERY_ROUTES_TABLE, { deliveryDate });
  const routesWithoutShopper = _.filter(allRoutes, ([, fields]) => {
    return (
      fields.shoppingVolunteer === null || fields.shoppingVolunteer.length !== 1
    );
  });
  if (routesWithoutShopper.length > 0) {
    const msg = 'Some routes are missing a shopping volunteer';
    console.error(msg, _.map(routesWithoutShopper, ([, fields]) => {
      return fields.name;
    }));
    throw new Error(msg);
  }
  return allRoutes;
}

function getTicketsForRoute([, fields]) {
  return _.map(fields.intakeTickets, (ticketRef) => {
    return getRecord(INTAKE_TABLE, ticketRef);
  });
}

async function getTicketsForRoutes(allRoutes) {
  return _.sortBy(
    await Promise.all(_.flatMap(allRoutes, getTicketsForRoute)),
    ([, fields]) => {
      return fields.ticketID;
    }
  );
}

class ReconciledOrder {
  constructor(
    intakeRecord,
    requested,
    provided,
    bulkDeliveryRoutes,
    volunteerRecords,
    itemToCategory,
  ) {
    this.intakeRecord = intakeRecord;
    this.requested = requested;
    this.provided = provided;
    this.bulkDeliveryRoutes = bulkDeliveryRoutes;
    this.volunteerRecords = volunteerRecords;
    this.itemToCategory = itemToCategory;
  }

  renderPackingSlip(singleCategory, slipNumber) {
    const fields = this.intakeRecord[1];

    const [, bulkRoute] = _.find(this.bulkDeliveryRoutes, ([id, ,]) => {
      return id === fields.bulkRoute[0];
    });
    const [, volunteer] = _.find(this.volunteerRecords, ([id, ,]) => {
      return id === bulkRoute.deliveryVolunteer[0];
    });

    let markdown = `# **${fields.ticketID}** (Route ${bulkRoute.name}): ${
      fields.requestName
    } (${fields.nearestIntersection.trim()})\n\n`;

    markdown += `**Delivery**: ${volunteer.Name}\n\n`;
    markdown += `**Sheet**: ${slipNumber + 1}/3\n\n`;

    const itemGroups = _.groupBy(_.toPairs(this.provided), ([item]) => {
      return _.includes(['Bread', 'Bananas'], item)
        ? 'Last'
        : this.itemToCategory[item];
    });

    const categoryOrder = singleCategory
      ? [singleCategory]
      : ['Non-perishable', 'Produce', 'Last'];

    const renderTable = (groups, categories) => {
      const numRows = _.max(
        _.map(_.toPairs(groups), ([category, items]) => {
          return _.includes(categories, category) ? items.length : 0;
        })
      );
      markdown += '| ';
      _.forEach(categories, (category) => {
        markdown += ` ${category} |`;
      });
      markdown += '\n';
      _.forEach(categories, () => {
        markdown += ' --- |';
      });
      for (var i = 0; i < numRows; i++) {
        markdown += '\n|';
        for (const category of categories) {
          const items = groups[category];
          if (items === undefined || i >= items.length) {
            markdown += ' &nbsp; |';
          } else {
            markdown += ` ${items[i][1]} ${items[i][0]} |`;
          }
        }
      }
      markdown += '\n';
    };
    renderTable(itemGroups, categoryOrder);

    if (
      !singleCategory &&
      (!_.isNull(fields.otherItems) ||
        !_.isEqual(this.provided, this.requested))
    ) {
      const otherItems = this.getAdditionalItems();
      if (otherItems.length > 0) {
        markdown += '\n---\n';

        const renderOtherTable = (items) => {
          const numCols = 2;
          const numRows = _.ceil(items.length / 2.0);
          markdown += '| Other |\n| --- |';
          var i = 0;
          for (var row = 0; row < numRows; row++) {
            markdown += '\n|';
            for (var col = 0; col < numCols; col++) {
              if (i >= items.length) {
                markdown += ' &nbsp; |';
              } else {
                markdown += ` ${items[i][1]} ${items[i][0]} |`;
                i++;
              }
            }
          }
          markdown += '\n';
        };
        renderOtherTable(otherItems);
      }
    }

    return markdown;
  }

  getAdditionalItems() {
    const fields = this.intakeRecord[1];
    const missingItems = _.filter(
      _.map(_.toPairs(this.requested), ([item, numRequested]) => {
        return [item, numRequested - _.get(this.provided, item, 0)];
      }),
      ([, diff]) => {
        return diff !== 0;
      }
    );

    const customItems = !_.isNull(fields.otherItems)
      ? _.map(
        _.filter(
          _.map(fields.otherItems.split(','), (item) => {
            return item.trim();
          }),
          (item) => {
            return item.length > 0;
          }
        ),
        (item) => {
          return [item, ''];
        }
      )
      : [];

    return missingItems.concat(customItems);
  }
}

/**
 * Reconcile bulk delivery orders with procured items from Bulk Order table.
 * @param {[string, Object, Object][]} allRoutes All bulk delivery routes for this week.
 * @param {Date} deliveryDate Date these orders will go out.
 * @returns {Promise<ReconciledOrder[]>} List of reconciled orders.
 */
async function reconcileOrders(allRoutes, deliveryDate) {
  const itemToCategory = _.fromPairs(
    _.map(await getAllRecords(ITEMS_BY_HOUSEHOLD_SIZE_TABLE), ([, fields]) => {
      return [fields.item, fields.category];
    })
  );

  const intakeRecords = await getTicketsForRoutes(allRoutes);

  const itemToNumAvailable = await getItemToNumAvailable(deliveryDate);

  const volunteerRecords = await getAllRecords(VOLUNTEER_FORM_TABLE);

  // Cannot be async, we need to process tickets in a deterministic order.
  const orders = [];
  for (const record of intakeRecords) {
    const itemToNumRequested = await getBulkOrder([record]);

    const itemToNumProvided = _.fromPairs(
      _.filter(
        _.map(_.toPairs(itemToNumRequested), ([item, numRequested]) => {
          return [item, _.min([numRequested, itemToNumAvailable[item] || 0])];
        }),
        ([, numProvided]) => {
          return numProvided !== 0;
        }
      )
    );

    // Update the num available for the bulk items we are providing for this ticket
    _.assign(
      itemToNumAvailable,
      _.fromPairs(
        _.map(_.toPairs(itemToNumProvided), ([item, numProvided]) => {
          return [item, itemToNumAvailable[item] - numProvided];
        })
      )
    );

    orders.push(
      new ReconciledOrder(
        record,
        itemToNumRequested,
        itemToNumProvided,
        allRoutes,
        volunteerRecords,
        itemToCategory,
      )
    );
  }

  _.forEach(_.entries(itemToNumAvailable), ([item, numAvailable]) => {
    if (numAvailable < 0) {
      throw Error(
        `Accounting for ${item} was off, found ${numAvailable} leftovers`
      );
    }
  });

  return orders;
}

/* META */

async function _findMetaRecord(key) {
  if (!Object.values(META_STORE_KEYS).includes(key)) {
    throw Error('The provided key is not a valid key in the meta store', {
      key: key,
    });
  }

  const query = base(META_TABLE).select({
    filterByFormula: `{Name} = "${key}"`,
  });
  const records = (await query.all()).map(normalizeRecords(META_TABLE));

  if (records.length === 0) {
    throw Error('Did not find a meta entry', { key: key });
  } else if (records.length > 1) {
    throw Error('Found duplicate meta entries', { key: key });
  }

  return records[0];
}

// Gets a meta object stored in the `_meta` table
async function getMeta(key) {
  return (await _findMetaRecord(key))[2];
}

async function storeMeta(key, data) {
  return await updateRecord(
    META_TABLE,
    (await _findMetaRecord(key))[0],
    {},
    data
  );
}

/* EXPORT */

module.exports = {
  BULK_DELIVERY_ROUTES_TABLE: BULK_DELIVERY_ROUTES_TABLE,
  BULK_ORDER_TABLE: BULK_ORDER_TABLE,
  INBOUND_TABLE: INBOUND_TABLE,
  INTAKE_TABLE: INTAKE_TABLE,
  ITEMS_BY_HOUSEHOLD_SIZE_TABLE: ITEMS_BY_HOUSEHOLD_SIZE_TABLE,
  META_STORE_KEYS: META_STORE_KEYS,
  META_TABLE: META_TABLE,
  REIMBURSEMENTS_TABLE: REIMBURSEMENTS_TABLE,
  VOLUNTEER_FORM_TABLE: VOLUNTEER_FORM_TABLE,
  createMessage: createMessage,
  createRecord: createRecord,
  createVoicemail: createVoicemail,
  deleteRecord: deleteRecord,
  getAllRecords: getAllRecords,
  getBulkOrder: getBulkOrder,
  getChangedRecords: getChangedRecords,
  getLastNonDuplicate: getLastNonDuplicate,
  getMeta: getMeta,
  getRecord: getRecord,
  getRecordsWithFilter: getRecordsWithFilter,
  getRecordsWithStatus: getRecordsWithStatus,
  getRecordsWithTicketID: getRecordsWithTicketID,
  getTicketDueDate: getTicketDueDate,
  getTicketDueIn: getTicketDueIn,
  getVolunteerSlackID: getVolunteerSlackID,
  getItemToNumAvailable: getItemToNumAvailable,
  getItemsByHouseholdSize: getItemsByHouseholdSize,
  getAllRoutes: getAllRoutes,
  getTicketsForRoutes: getTicketsForRoutes,
  reconcileOrders: reconcileOrders,
  storeMeta: storeMeta,
  updateRecord: updateRecord,
  ReconciledOrder: ReconciledOrder,
};
