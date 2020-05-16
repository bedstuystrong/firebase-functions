const functions = require('firebase-functions');

const fs = require('fs');
const util = require('util');

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

// Translates airtable names to bigquery table names
const TABLE_TO_NAME = {
  [INBOUND_TABLE]: 'inbound',
  [INTAKE_TABLE]: 'intake',
  [REIMBURSEMENTS_TABLE]: 'reimbursements',
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

              if (type === 'TIMESTAMP') {
                const date = new Date(val);

                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const hour = String(date.getHours()).padStart(2, '0');
                const minute = String(date.getMinutes()).padStart(2, '0');
                const second = String(date.getSeconds()).padStart(2, '0');

                // NOTE that dates need to be of the format YYYY-MM-DD HH:MM:SS
                val = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
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
  const name = TABLE_TO_NAME[table];

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
  await bigQueryClient.dataset(OPS_DATASET_ID).createTable(name, { schema: schema });
}

async function deleteTable(table) {
  await bigQueryClient.dataset(OPS_DATASET_ID).table(TABLE_TO_NAME[table]).delete();
}

async function populateTable(table) {
  // TODO : filter out only the fields we need to populate the bigquery table
  const allRecords = await getAllRecords(table);
  const convertedRecords = _.map(allRecords, _convertRecords(table));

  const name = TABLE_TO_NAME[table];
  const tmpFilePath = '/tmp/' + name;

  console.log(`Writing ${allRecords.length} records to bigquery table...`, { table: TABLE_TO_NAME[table] });

  await util.promisify(fs.writeFile)(
    tmpFilePath,
    _.join(_.map(convertedRecords, JSON.stringify), '\n'),
  );

  await bigQueryClient.dataset(OPS_DATASET_ID).table(name).load(tmpFilePath, { format: 'JSON' });
}

// Regenerates a bigquery table: deleting, creating, and populating it
async function regenerateTable(table) {
  console.log(`Processing table ${TABLE_TO_NAME[table]}...`);

  await deleteTable(table);
  await createTable(table);
  await populateTable(table);
}

// Regenerates all bigquery tables
async function regenerateAllTables() {
  for (const table of [INBOUND_TABLE, INTAKE_TABLE, REIMBURSEMENTS_TABLE]) {
    await regenerateTable(table);
  }
}

module.exports = {
  createTable: createTable,
  deleteTable: deleteTable,
  populateTable: populateTable,
  regenerateTable: regenerateTable,
  regenerateAllTables: regenerateAllTables,
};
