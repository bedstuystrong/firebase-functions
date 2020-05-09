const {
  regenerateAllTables
} = require('../bigquery');

async function main() {
  console.log('Creating and populating tables...');
  await regenerateAllTables();
  console.log('Done.');
}

main().then(
  () => console.log('Done')
).catch(
  (err) => console.log('Error!', { err: err })
);
