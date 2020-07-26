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
  const { argv } = yargs.option('deliveryDate', {
    coerce: (x) => new Date(x),
    demandOption: true,
    describe: 'Date of scheduled delivery (yyyy-mm-dd format)',
  });

  const orders = await reconcileOrders(argv.deliveryDate);

  console.log('Creating packing slips...');

  const outPath = await savePackingSlips(orders);
  console.log('Wrote packing slips to', outPath);
}

main()
  .then(() => console.log('Done.'))
  .catch((err) => console.log('Error!', { err: err }));
