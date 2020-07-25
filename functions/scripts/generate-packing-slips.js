const fs = require("fs");
const { Readable, finished } = require("stream");

const _ = require("lodash");
const moment = require("moment");
const markdownpdf = require("markdown-pdf");
const pdfmerge = require("easy-pdf-merge");
const util = require("util");
const yargs = require("yargs");

const {
  BULK_ORDER_TABLE,
  INTAKE_TABLE,
  ITEMS_BY_HOUSEHOLD_SIZE_TABLE,
  VOLUNTEER_FORM_TABLE,
  getAllRecords,
  getRecordsWithStatus,
  getBulkOrder,
  getItemToNumAvailable,
  PackingSlip,
  getPackingSlips,
  BULK_DELIVERY_ROUTES_TABLE,
} = require("../airtable");

async function savePackingSlips(packingSlips) {
  const itemToCategory = _.fromPairs(
    _.map(await getAllRecords(ITEMS_BY_HOUSEHOLD_SIZE_TABLE), ([, fields]) => {
      return [fields.item, fields.category];
    })
  );

  try {
    await fs.promises.mkdir("out/");
  } catch (e) {
    if (e.code !== "EEXIST") {
      throw e;
    }
  }

  const outPaths = await Promise.all(
    _.flatMap(packingSlips, (slip) => {
      const sheetCategories = [null, "Cleaning Bundle", "Fridge / Frozen"];
      return _.map(sheetCategories, async (category, i) => {
        const outPath = `out/${slip.intakeRecord[1].ticketID}-${i}.pdf`;

        // NOTE that I used A3 page size here (which is longer than A4) to ensure
        // that we didn't use two pages for one ticket
        const stream = Readable.from([
          slip.getMarkdown(itemToCategory, category, i),
        ])
          .pipe(
            markdownpdf({
              paperFormat: "A3",
              cssPath: "functions/scripts/packing-slips.css",
              paperOrientation: "portrait",
            })
          )
          .pipe(fs.createWriteStream(outPath));
        await util.promisify(finished)(stream);

        return outPath;
      });
    })
  );

  const mergedOutPath = "out/packing_slips.pdf";

  await util.promisify(pdfmerge)(outPaths, mergedOutPath);

  // TODO : do the collating and conversation to A4 page size here

  return mergedOutPath;
};

async function main() {
  const { argv } = yargs.option("delivery-date", {
    coerce: (x) => moment(new Date(x)).utc().format("YYYY-MM-DD"),
    demandOption: true,
    describe: "Date of scheduled delivery (yyyy-mm-dd format)",
  });

  const intakeRecords = _.sortBy(await getRecordsWithStatus(
    INTAKE_TABLE,
    "Bulk Delivery Confirmed"
  ), ([, fields,]) => fields.ticketID);

  console.log(`Found ${intakeRecords.length} bulk delivery confirmed tickets.`);

  const bulkOrderRecords = _.filter(
    await getAllRecords(BULK_ORDER_TABLE),
    ([, fields]) => {
      return fields.deliveryDate === argv.deliveryDate;
    }
  );

  const itemToNumAvailable = await getItemToNumAvailable(bulkOrderRecords);

  const bulkDeliveryRoutes = await getAllRecords(BULK_DELIVERY_ROUTES_TABLE);

  const volunteerRecords = await getAllRecords(VOLUNTEER_FORM_TABLE);

  const packingSlips = await getPackingSlips(intakeRecords, itemToNumAvailable, bulkDeliveryRoutes, volunteerRecords);

  _.forIn(_.toPairs(itemToNumAvailable), ([item, numAvailable]) => {
    if (numAvailable < 0) {
      throw Error(
        `Accounting for ${item} was off, found ${numAvailable} leftovers`
      );
    }
  });

  console.log("Creating packing slips...");

  const outPath = await savePackingSlips(packingSlips);

  console.log(`Merged packing slips: ${outPath}`);
}

main()
  .then(() => console.log("Done."))
  .catch((err) => console.log("Error!", { err: err }));
