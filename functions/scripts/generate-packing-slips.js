const fs = require('fs');
const { Readable, finished } = require('stream');

const _ = require('lodash');
const markdownpdf = require('markdown-pdf');
const pdfmerge = require('easy-pdf-merge');
const util = require('util');

const {
  BULK_ORDER_TABLE,
  INTAKE_TABLE,
  ITEMS_BY_HOUSEHOLD_SIZE_TABLE,
  getAllRecords,
  getRecordsWithStatus,
  getBulkOrder,
} = require('../airtable');

class PackingSlip {
  constructor(intakeRecord, requested, provided) {
    this.intakeRecord = intakeRecord;
    this.requested = requested;
    this.provided = provided;
  }

  getMarkdown(itemToCategory) {
    const fields = this.intakeRecord[1];

    let markdown = `# **${fields.ticketID}**: ${fields.requestName} (${fields.nearestIntersection})\n\n`;

    _.forEach(
      _.toPairs(
        _.groupBy(
          _.toPairs(this.provided),
          ([item,]) => { return itemToCategory[item]; },
        )
      ),
      ([category, provided]) => {
        markdown += `### **${category}**:\n`;
        _.forEach(
          provided,
          ([item, numProvided]) => {
            markdown += `- ${numProvided} ${item}\n`;
          }
        );
        markdown += '\n';
      },
    );

    if (!_.isNull(fields.otherItems) || !_.isEqual(this.provided, this.requested)) {
      markdown += '\n---\n';
      markdown += '## **Other** (Provided By Bed-Stuy Strong!):\n';

      if (!_.isEqual(this.provided, this.requested)) {
        markdown += '### Missing:\n';

        const missing = _.filter(
          _.map(
            _.toPairs(this.requested),
            ([item, numRequested]) => {
              return [item, numRequested - _.get(this.provided, item, 0)];
            },
          ),
          ([, diff]) => { return diff !== 0; },
        );

        _.forEach(
          missing,
          ([item, numMissing]) => {
            markdown += `- ${numMissing} ${item}\n`;
          }
        );
      }

      if (!_.isNull(fields.otherItems)) {
        markdown +=  `### Custom Items: ${fields.otherItems}\n`;
      }
    }

    return markdown;
  }
}

async function savePackingSlips(packingSlips) {
  const itemToCategory = _.fromPairs(
    _.map(
      await getAllRecords(ITEMS_BY_HOUSEHOLD_SIZE_TABLE),
      ([, fields,]) => { return [fields.item, fields.category]; },
    )
  );

  // TODO : remove the out directory

  await fs.promises.mkdir('out/');

  const outPaths = await Promise.all(
    _.map(
      packingSlips,
      async (slip) => {
        const outPath = `out/${slip.intakeRecord[1].ticketID}.pdf`;

        // NOTE that I used A3 page size here (which is longer than A4) to ensure 
        // that we didn't use two pages for one ticket
        const stream = Readable.from([slip.getMarkdown(itemToCategory)]).pipe(
          markdownpdf({paperFormat: 'A3'})
        ).pipe(fs.createWriteStream(outPath));
        await util.promisify(finished)(stream);

        return outPath;
      },
    )
  );

  const mergedOutPath = 'out/packing_slips.pdf';

  await util.promisify(pdfmerge)(outPaths, mergedOutPath);

  // TODO : do the collating and conversation to A4 page size here

  return mergedOutPath;
}

async function main() {
  const intakeRecords = await getRecordsWithStatus(INTAKE_TABLE, 'Bulk Delivery Confirmed');

  console.log(`Found ${intakeRecords.length} bulk delivery confirmed tickets.`);

  const bulkOrderRecords = await getAllRecords(BULK_ORDER_TABLE);

  const itemToNumAvailable = _.fromPairs(
    _.map(
      bulkOrderRecords,
      ([, fields,]) => { return [fields.item, fields.quantity]; },
    )
  );

  const packingSlips = await Promise.all(
    _.map(
      intakeRecords,
      async (record) => {
        const itemToNumRequested = await getBulkOrder([record]);

        const itemToNumProvided = _.fromPairs(
          _.filter(
            _.map(
              _.toPairs(itemToNumRequested),
              ([item, numRequested]) => {
                return [item, _.min([numRequested, itemToNumAvailable[item]])];
              }
            ),
            ([, numProvided]) => {
              return numProvided !== 0;
            }
          ),
        );

        // Update the num available for the bulk items we are providing for this ticket
        _.assign(
          itemToNumAvailable,
          _.fromPairs(
            _.map(
              _.toPairs(itemToNumProvided),
              ([item, numProvided]) => { return [item, itemToNumAvailable[item] - numProvided]; },
            )
          )
        );

        return new PackingSlip(record, itemToNumRequested, itemToNumProvided);
      },
    )
  );

  _.forIn(
    _.toPairs(itemToNumAvailable),
    ([item, numAvailable]) => {
      if (numAvailable < 0) {
        throw Error(`Accounting for ${item} was off, found ${numAvailable} leftovers`);
      }
    },
  );

  console.log('Creating packing slips...');

  const outPath = await savePackingSlips(packingSlips);

  console.log(`Merged packing slips: ${outPath}`);
}

main().then(
  () => console.log('Done.')
).catch(
  (err) => console.log('Error!', { err: err })
);
