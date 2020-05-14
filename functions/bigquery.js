const functions = require('firebase-functions');

const _ = require('lodash');

const { BigQuery } = require('@google-cloud/bigquery');

const {
  INBOUND_TABLE,
  INTAKE_TABLE,
  REIMBURSEMENTS_TABLE,
  getAllRecords
} = require('./airtable');

const bigQueryClient = new BigQuery({
  projectId: functions.config().bigquery.project_id,
  credentials: {
    private_key: functions.config().bigquery.credentials.private_key.split('\\n').join('\n'),
    client_email: functions.config().bigquery.credentials.client_email,
  }
});

const OPS_DATASET_ID = 'operations';

const INBOUND_TYPES = {
  id: 'STRING',
  status: 'STRING',
  intakeTime: 'TIMESTAMP',
  method: 'STRING',
};

const INTAKE_TYPES = {
  id: 'STRING',
  dateCreated: 'TIMESTAMP',
  dueDate: 'TIMESTAMP',
  costCategory: 'INTEGER',
  householdSize: 'INTEGER',
  items: 'STRING',
  neighborhood: 'STRING',
  status: 'STRING',
  ticketID: 'STRING',
  timeline: 'STRING',
  vulnerability: 'STRING',
};

const REIMBURSEMENT_TYPES = {
  id: 'STRING',
  ticketRecords: 'STRING',
  totalCost: 'FLOAT',
  donation: 'FLOAT',
  netReimbursement: 'FLOAT',
  // TODO : get rid of this nonesense
  fundMgr: 'STRING',
  dateSubmitted: 'TIMESTAMP',
  paymentPlatform: 'STRING',
};

const TABLE_TO_TYPES = {
  [INBOUND_TABLE]: INBOUND_TYPES,
  [INTAKE_TABLE]: INTAKE_TYPES,
  [REIMBURSEMENTS_TABLE]: REIMBURSEMENT_TYPES,
};

function _convertRecords(table) {
  return ([id, fields]) => {
    if (!_.has(TABLE_TO_TYPES, table)) {
      throw Error('Invalid table', { table: table });
    }

    return _.assign(
      { id: id },
      // Filter out all fields with null values
      _.pickBy(
        // Map fields in the record to fields in the bigquery type mappings
        _.mapValues(
          TABLE_TO_TYPES[table],
          (type, fieldName) => {
            let val = fields[fieldName];

            if (!val) {
              return null;
            }

            // Validate types and values
            if (type === 'STRING' || type === 'TIMESTAMP') {
              // XXX : we automatically comma-join arrays
              if (_.isArray(val)) {
                val = _.join(val, ',');
              } else if (typeof val !== 'string') {
                throw Error(
                  'Invalid value for field',
                  { table: table, field: fieldName, val: val }
                );
              }

              return val;
            } else if (type === 'INTEGER' || type === 'FLOAT') {
              if (typeof val !== 'number') {
                throw Error(
                  'Invalid value for field',
                  { table: table, field: fieldName, val: val }
                );
              }

              return val;
            } else {
              throw Error('Invalid field for table', { fieldName: fieldName, table: table });
            }
          },
        ),
        (value) => !_.isNull(value),
      )
    );
  };
}

async function createTable(table) {
  const types = TABLE_TO_TYPES[table];

  if (!types) {
    throw Error('Unsupported table', { table: table });
  }

  const schema = _.map(
    _.entriesIn(types),
    ([fieldName, type]) => {
      return {
        name: fieldName,
        type: type,
      };
    },
  );

  // Create a new table in the dataset
  await bigQueryClient.dataset(OPS_DATASET_ID).createTable(table, { schema: schema });
}

async function deleteTable(table) {
  await bigQueryClient.dataset(OPS_DATASET_ID).table(table).delete();
}

async function populateTable(table) {
  // TODO : filter out only the fields we need to populate the bigquery table
  const allRecords = await getAllRecords(table);  

  console.log(`Writing ${allRecords.length} records to bigquery table...`, { table: table });

  for (const rec of allRecords) {
    await bigQueryClient.dataset(OPS_DATASET_ID).table(table).insert(
      _convertRecords(table)(rec)
    );
  }
}

// Regenerates all bigquery tables: deleting, creating, and populating them
async function regenerateAllTables() {
  for (const table of [INBOUND_TABLE, INTAKE_TABLE, REIMBURSEMENTS_TABLE]) {
    console.log(`Processing table ${table}`);

    await deleteTable(table);
    await createTable(table);
    await populateTable(table);
  }
}

module.exports = {
  createTable: createTable,
  deleteTable: deleteTable,
  populateTable: populateTable,
  regenerateAllTables: regenerateAllTables,
};
