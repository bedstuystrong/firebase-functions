const fs = require('fs');

const _ = require('lodash');
const markdownpdf = require('markdown-pdf');
const pdfmerge = require('easy-pdf-merge');
const util = require('util');
const yargs = require('yargs');

const {
  reconcileOrders,
  // eslint-disable-next-line no-unused-vars
  ReconciledOrder,
} = require('../airtable');

/**
 * Render one packing slip for this order.
 * @param {ReconciledOrder} order Reconciled order
 * @param {string | null} singleCategory Render one category, or all others
 * @param {number} slipNumber Which slip number this is
 * @returns {string} markdown for this packing slip
 */
function renderPackingSlip(order, singleCategory, slipNumber) {
  const itemGroups = order.bulkPurchasedItemsByGroup();

  const fields = order.intakeRecord[1];

  let markdown = `# **${fields.ticketID}** (Route ${order.bulkDeliveryRoute.name}): ${fields.requestName} (${fields.nearestIntersection.trim()})\n\n`;

  markdown += `**Delivery**: ${order.volunteer.Name}\n\n`;
  markdown += `**Sheet**: ${slipNumber + 1}/3\n\n`;

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

  if (!singleCategory && (!_.isNull(fields.otherItems) || !_.isEqual(order.provided, order.requested))) {
    const otherItems = order.getAdditionalItems();
    if (otherItems.length > 0) {
      markdown += '\n---\n';

      /**
       * @param {[{ item: string, quantity: number | null }]} items List of
       * items to purchase.
       */
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
              markdown += ` ${items[i].quantity || ''} ${items[i].item} |`;
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

/**
 * Render packing slips into one PDF file.
 * @param {ReconciledOrder[]} orders orders to render
 * @returns {Promise<string>} Path PDF was written to.
 */
async function savePackingSlips(orders) {
  try {
    await fs.promises.mkdir('out/');
  } catch (e) {
    if (e.code !== 'EEXIST') {
      throw e;
    }
  }

  const PDF = markdownpdf({
    paperFormat: 'A3',
    cssPath: 'functions/scripts/packing-slips.css',
    paperOrientation: 'portait',
  });

  // Three sheets, one with Cleaning Bundle, one Fridge / Frozen, one with
  // everything else.
  const sheetCategories = [null, 'Cleaning Bundle', 'Fridge / Frozen'];
  const outPaths = await Promise.all(_.flatMap(orders, (order) => {
    return _.map(sheetCategories, async (category, i) => {
      const markdown = renderPackingSlip(order, category, i);
      const stream = PDF.from.string(markdown);
      const outPath = `out/${order.intakeRecord[1].ticketID}-${i}.pdf`;
      // @ts-ignore stream.to.path's callback isn't of the right type for
      // promisify
      await util.promisify(stream.to.path)(outPath);
      return outPath;
    });
  }));

  const mergedOutPath = 'out/packing_slips.pdf';
  // @ts-ignore pdfmerge's callback isn't of the right type for promisify
  await util.promisify(pdfmerge)(outPaths, mergedOutPath);

  await Promise.all(_.map(outPaths, (path) => {
    return fs.promises.unlink(path);
  }));

  return mergedOutPath;
}

async function main() {
  const usageText = 'Usage: $0 --delivery-date YYYY-MM-DD'
    + '\n\nGenerates packing slips as a PDF in the out/ directory. This needs to be sent to Brooklyn Packers prior to delivery day, so they can label the boxes to know what to pack in each one.'
    + '\n\nPreconditions:'
    + '\n\n  This script reads the Bulk Delivery Routes table for the specified date, and looks up the Intake Tickets attached to those routes, so check those tables for correctness before running this.'
    + '\n\n  This script also reads the Bulk Order table to compare it with the total groceries requested in tickets scheduled for bulk delivery, to determine what extra items we did not procure, which will go in the Other section, so check to make sure that table has been updated to reflect the actually procured bulk items before running this.'
    + '\n\n  You should run this together with email-bulk-shopping-volunteers.js in --dry-run mode, so that the shopping lists for shopping volunteers accurately match the items in the Other category on the packing slips.'
    + '\n\n    You should probably run this to generate the packing slips, and run email-bulk-shopping-volunteers.js in --dry-run mode, and check at least a few tickets to make sure that the shopping lists match the Other category on the packing slips, before sending the packing slips to Brooklyn Packers or the shopping lists to our Shopping Volunteers.';
  const { argv } = yargs
    .option('deliveryDate', {
      coerce: (x) => new Date(x),
      demandOption: true,
      describe: 'Date of scheduled delivery (yyyy-mm-dd format)',
    })
    .usage(usageText);

  const orders = await reconcileOrders(argv.deliveryDate);

  const outPath = await savePackingSlips(orders);
  console.log(`********************************************************************************\n\nNEXT STEPS!\n\nPacking slips have been generated in ${outPath}.\n\nNow, make sure the Bulk Delivery Coordinator gets this forwarded to Brooklyn Packers!\n\n********************************************************************************`);
}

main()
  .then(() => console.log('Done.'))
  .catch((err) => console.log('Error!', { err: err }));
