const fs = require('fs');
const { Readable, finished } = require('stream');

const _ = require('lodash');
const moment = require('moment');
const markdownpdf = require('markdown-pdf');
const pdfmerge = require('easy-pdf-merge');
const util = require('util');
const yargs = require('yargs');

const {
  BULK_ORDER_TABLE,
  INTAKE_TABLE,
  ITEMS_BY_HOUSEHOLD_SIZE_TABLE,
  VOLUNTEER_FORM_TABLE,
  getAllRecords,
  getRecordsWithStatus,
  getBulkOrder,
  BULK_DELIVERY_ROUTES_TABLE,
} = require('../airtable');

class PackingSlip {
  constructor(intakeRecord, requested, provided, bulkDeliveryRoutes, volunteerRecords) {
    this.intakeRecord = intakeRecord;
    this.requested = requested;
    this.provided = provided;
    this.bulkDeliveryRoutes = bulkDeliveryRoutes;
    this.volunteerRecords = volunteerRecords;
  }

  getMarkdown(itemToCategory, singleCategory, slipNumber) {
    const fields = this.intakeRecord[1];

    const [, bulkRoute,] = _.find(this.bulkDeliveryRoutes, ([id,,]) => { return id === fields.bulkRoute[0]; });
    const [, volunteer,] = _.find(this.volunteerRecords, ([id,,]) => { return id === bulkRoute.deliveryVolunteer[0]; });

    let markdown = `# **${fields.ticketID}** (Route ${bulkRoute.name}): ${fields.requestName} (${fields.nearestIntersection.trim()})\n\n`;

    markdown += `**Delivery**: ${volunteer.Name}\n\n`;
    markdown += `**Sheet**: ${slipNumber + 1}/3\n\n`;

    const itemGroups = _.groupBy(
      _.toPairs(this.provided),
      ([item,]) => { return _.includes(['Bread', 'Bananas'], item) ? 'Last' : itemToCategory[item]; }
    );

    const categoryOrder = singleCategory ? [singleCategory] : [
      'Produce',
      'Non-perishable',
      'Last',
    ];

    const renderTable = (groups, categories) => {
      const numRows = _.max(
        _.map(
          _.toPairs(groups),
          ([category, items]) => {
            return _.includes(categories, category) ? items.length : 0;
          }
        )
      );
      markdown += '| ';
      _.forEach(categories, (category) => { markdown += ` ${category} |`; });
      markdown += '\n';
      _.forEach(categories, () => { markdown += ' --- |'; });
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

    if (!singleCategory && (!_.isNull(fields.otherItems) || !_.isEqual(this.provided, this.requested))) {
      const missingItems = _.filter(
        _.map(
          _.toPairs(this.requested),
          ([item, numRequested]) => {
            return [item, numRequested - _.get(this.provided, item, 0)];
          },
        ),
        ([, diff]) => { return diff !== 0; },
      );

      const customItems = (
        !_.isNull(fields.otherItems)
          ? _.map(
            _.filter(
              _.map(
                fields.otherItems.split(','),
                (item) => { return item.trim(); }
              ),
              (item) => { return item.length > 0; }
            ),
            (item) => { return [item, '']; }
          )
          : []
      );

      const otherItems = missingItems.concat(customItems);

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
}

async function savePackingSlips(packingSlips) {
  const itemToCategory = _.fromPairs(
    _.map(
      await getAllRecords(ITEMS_BY_HOUSEHOLD_SIZE_TABLE),
      ([, fields,]) => { return [fields.item, fields.category]; },
    )
  );

  try {
    await fs.promises.mkdir('out/');
  } catch (e) {
    if (e.code !== 'EEXIST') {
      throw e;
    }
  }

  const outPaths = await Promise.all(
    _.flatMap(
      packingSlips,
      (slip) => {
        const sheetCategories = [null, 'Cleaning Bundle', 'Fridge / Frozen'];
        return _.map(
          sheetCategories,
          async (category, i) => {
            const outPath = `out/${slip.intakeRecord[1].ticketID}-${i}.pdf`;

            // NOTE that I used A3 page size here (which is longer than A4) to ensure 
            // that we didn't use two pages for one ticket
            const stream = Readable.from([slip.getMarkdown(itemToCategory, category, i)]).pipe(
              markdownpdf({paperFormat: 'A3', cssPath: 'functions/scripts/packing-slips.css', paperOrientation: 'portrait'})
            ).pipe(fs.createWriteStream(outPath));
            await util.promisify(finished)(stream);
    
            return outPath;
          },
        );
      },
    )
  );

  const mergedOutPath = 'out/packing_slips.pdf';

  await util.promisify(pdfmerge)(outPaths, mergedOutPath);

  // TODO : do the collating and conversation to A4 page size here

  return mergedOutPath;
}

async function main() {
  const { argv } = yargs.option('delivery-date', {
    coerce: (x) => moment(new Date(x)).utc().format('YYYY-MM-DD'),
    demandOption: true,
    describe: 'Date of scheduled delivery (yyyy-mm-dd format)',
  });

  const intakeRecords = await getRecordsWithStatus(INTAKE_TABLE, 'Bulk Delivery Confirmed');

  console.log(`Found ${intakeRecords.length} bulk delivery confirmed tickets.`);

  const bulkOrderRecords = _.filter(await getAllRecords(BULK_ORDER_TABLE), ([, fields,]) => { return fields.deliveryDate === argv.deliveryDate; });

  const itemToNumAvailable = _.fromPairs(
    _.map(
      bulkOrderRecords,
      ([, fields,]) => { return [fields.item, fields.quantity]; },
    )
  );

  const bulkDeliveryRoutes = await getAllRecords(BULK_DELIVERY_ROUTES_TABLE);

  const volunteerRecords = await getAllRecords(VOLUNTEER_FORM_TABLE);

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
                return [item, _.min([numRequested, itemToNumAvailable[item] || 0])];
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

        return new PackingSlip(record, itemToNumRequested, itemToNumProvided, bulkDeliveryRoutes, volunteerRecords);
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
