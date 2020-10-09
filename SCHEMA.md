# Airtable schemas

Airtable is great, but one pain point is that column names don't have unique IDs. If someone changes a column name in the UI, it can break your code! There are two ways we can make this less brittle:
1. Be smart about Airtable permissions: most volunteers should be `Editors` at most. Those who coordinate volunteers and set up workflows should have `Creator` permissions, but should have a very solid understanding that they shouldn't rename or remove any columns without checking with a tech person.
2. Normalize Airtable records before working with them in the code by mapping the human-readable column names (e.g. `['Phone Number']`) to object properties (`phoneNumber`). 


The way we've implemented this is to create a set of schemas for each table (these live in `schema.js`) and `normalize` and `denormalize` methods. These methods take an Airtable record and a schema definition and basically just replace the keys. You can see some other utilities we've developed around this pattern, like `normalizeRecords`, in `airtable.js`. 