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
  getAllRoutes,
} = require('../airtable');

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
      const markdown = order.renderPackingSlip(category, i);
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
  return mergedOutPath;
}

async function main() {
  const { argv } = yargs.option('deliveryDate', {
    coerce: (x) => new Date(x),
    demandOption: true,
    describe: 'Date of scheduled delivery (yyyy-mm-dd format)',
  });
  const allRoutes = await getAllRoutes(argv.deliveryDate);

  const orders = await reconcileOrders(allRoutes, argv.deliveryDate);

  console.log('Creating packing slips...');

  const outPath = await savePackingSlips(orders);
  console.log('Wrote packing slips to', outPath);
}

main()
  .then(() => console.log('Done.'))
  .catch((err) => console.log('Error!', { err: err }));
