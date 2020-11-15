const {
  getLastNonDuplicate,
  getRecord,
} = require("../airtable")

async function main() {
  const rec = await getLastNonDuplicate("(817) 680-8185")
  const rec2 = await getRecord("recKVDL78YRCkADIw")

  console.log(rec)
  console.log(rec2)
}

main().then(
    () => console.log('done')
).catch(
  (e) => console.error(e)
)