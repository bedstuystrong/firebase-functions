const functions = require("firebase-functions");
const _ = require("lodash");
const moment = require("moment");
const sgMail = require("@sendgrid/mail");
const showdown = require("showdown");
const yargs = require("yargs");

sgMail.setApiKey(functions.config().sendgrid.api_key);

const {
  INTAKE_TABLE,
  BULK_ORDER_TABLE,
  VOLUNTEER_FORM_TABLE,
  BULK_DELIVERY_ROUTES_TABLE,
  getRecord,
  getAllRecords,
  getItemToNumAvailable,
  getPackingSlips,
  getItemsByHouseholdSize,
} = require("../airtable");

const googleMapsUrl = (address) =>
  `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURI(
    address + ", Brooklyn, NY"
  )}`;

function getBulkRoute([, fields]) {
  if (fields.bulkRoute.length !== 1) {
    throw new Error(`Ticket ${fields} does not have one Bulk Route`);
  }
  return fields.bulkRoute[0];
}

async function sendEmail(msg) {
  try {
    const response = await sgMail.send(msg);
    console.log(response);
  } catch (error) {
    console.error(error);

    if (error.response) {
      console.error(error.response.body);
    }
  }
}

async function main() {
  const { argv } = yargs
    .option("delivery-date", {
      coerce: (x) => moment(new Date(x)).utc().format("YYYY-MM-DD"),
      demandOption: true,
      describe: "Date of scheduled delivery (yyyy-mm-dd format)",
    })
    .boolean("dry-run");
  const allRoutes = _.filter(
    await getAllRecords(BULK_DELIVERY_ROUTES_TABLE),
    ([, fields]) => {
      return fields.deliveryDate === argv.deliveryDate;
    }
  );
  const routesWithoutShopper = _.filter(allRoutes, ([, fields]) => {
    return (
      fields.shoppingVolunteer === null || fields.shoppingVolunteer.length !== 1
    );
  });
  if (routesWithoutShopper.length > 0) {
    console.error(
      "Some routes are missing a shopping volunteer:",
      _.map(routesWithoutShopper, ([, fields]) => {
        return fields.name;
      })
    );
    //return null;
  }
  const routesByShopper = _.groupBy(
    _.filter(allRoutes, ([, fields]) => fields.shoppingVolunteer !== null),
    ([, fields]) => {
      return [
        fields.shoppingVolunteerEmail[0],
        fields.shoppingVolunteerName[0],
      ];
    }
  );

  const bulkOrderRecords = _.filter(
    await getAllRecords(BULK_ORDER_TABLE),
    ([, fields]) => {
      return fields.deliveryDate === argv.deliveryDate;
    }
  );

  const intakeRecords = _.sortBy(
    await Promise.all(
      _.flatMap(allRoutes, ([, fields]) => {
        return _.map(fields.intakeTickets, (ticketID) => {
          return getRecord(INTAKE_TABLE, ticketID);
        });
      })
    ),
    ([, fields]) => fields.ticketID
  );

  const itemToNumAvailable = await getItemToNumAvailable(bulkOrderRecords);

  const volunteerRecords = await getAllRecords(VOLUNTEER_FORM_TABLE);

  const packingSlips = await getPackingSlips(
    intakeRecords,
    itemToNumAvailable,
    allRoutes,
    volunteerRecords
  );

  const packingSlipsById = _.fromPairs(
    _.map(packingSlips, (slip) => {
      return [slip.intakeRecord[0], slip];
    })
  );

  const itemsByHouseholdSize = await getItemsByHouseholdSize();

  const emails = _.map(
    _.entries(routesByShopper),
    ([shoppingVolunteer, routes]) => {
      const [shoppingVolunteerEmail, shoppingVolunteerName] = _.split(
        shoppingVolunteer,
        ","
      );
      const firstName = shoppingVolunteerName.split(" ")[0];
      let markdown = `Hi ${firstName},\n\nThank you again for volunteering to shop for these custom items!\n\n`;
      markdown +=
        "Please sort the items so that each ticket ID has its own bag or bags, and label each one of the bags with its corresponding **route number and ticket ID**.\n\n";
      markdown += "There are a variety of ways you can label the bags:\n\n";
      markdown +=
        "1. write the route number and ticket ID on a slip of paper or post-it note and staple or tape it to the bag\n";
      markdown +=
        "2. write the route number and ticket ID on a slip of paper or post-it and just set it inside the bag with the groceries\n";
      markdown +=
        "3. write the route number and ticket ID directly on the grocery bag(s) with a Sharpie or other pen/marker that won't smear or rub off\n\n";
      markdown += `Please remember to bring at least one pen and some paper with you to the grocery store! We need drivers to drop these items off at the warehouse, **[221 Glenmore Ave, Gate 4](${googleMapsUrl(
        "221 Glenmore Ave"
      )}) by 12pm**, so please plan your shopping and a meetup time with your car teammate accordingly.\n\n`;
      markdown +=
        "Submit the [reimbursement form](https://airtable.com/shrvHf4k5lRo0I8F4) in the usual way, with the total amount you spent and images of your receipt(s). Just pick one ticket ID from your list and enter that. Please add a note that your reimbursement form is for **custom items shopping for bulk purchasing households on July 25th**.\n\n";
      markdown +=
        `Thanks so much! Call Jackson at ${functions.config().bulk_ops_team.warehouse_coordinator.phone_number} with any questions!\n\n`;
      markdown += "# Shopping List\n\n";
      markdown += "## No Route Number\n\n";
      markdown += " - [ ] Chicken: 9 individual 2 pound packs<br/>\n";
      markdown +=
        "   Don't sort this chicken by ticket, just put all chicken together in a single bag, and hand directly to Hanna or Jackson for cold storage and packing.\n\n";
      const slipsByRoute = _.map(
        _.sortBy(routes, ([, fields]) => fields.name),
        ([, fields]) => {
          return [
            fields.name,
            _.map(fields.intakeTickets, (ticketID) => {
              const slip = packingSlipsById[ticketID];
              return slip;
            }),
          ];
        }
      );
      _.forEach(slipsByRoute, ([routeName, slips]) => {
        markdown += `\n## Route ${routeName}\n`;
        _.forEach(
          _.sortBy(slips, (slip) => slip.intakeRecord[1].ticketID),
          (slip) => {
            const {
              ticketID,
              vulnerability,
              householdSize,
            } = slip.intakeRecord[1];
            const items = _.map(
              _.filter(slip.getAdditionalItems(), ([item]) => {
                return !(
                  _.endsWith(item, "art kit") || _.endsWith(item, "art kits")
                );
              }),
              ([item, quantity]) => ({
                category: itemsByHouseholdSize[item]
                  ? itemsByHouseholdSize[item].category
                  : "Custom",
                item,
                quantity,
                ticketID,
              })
            );
            if (items.length !== 0) {
              const conditions = _.join(_.concat([`household size ${householdSize}`], vulnerability), ", ");
              markdown += `\n**Ticket ${ticketID}** (${conditions})\n\n`;
              _.forEach(items, ({ quantity, item }) => {
                if (quantity !== "") {
                  markdown += ` - [ ] ${quantity} ${item}\n`;
                } else {
                  markdown += ` - [ ] ${item}\n`;
                }
              });
              markdown += "\n---\n";
            }
          }
        );
      });
      const converter = new showdown.Converter({
        tasklists: true,
      });
      const html = converter.makeHtml(markdown);

      const msg = {
        to: shoppingVolunteerEmail,
        cc: "operations+bulk@bedstuystrong.com",
        bcc: "leif.walsh@gmail.com",
        replyTo: "operations+bulk@bedstuystrong.com",
        from: functions.config().sendgrid.from,
        subject: `[BSS Bulk Ordering] July 25th Delivery Prep and Instructions for ${
          firstName.split(" ")[0]
        }`,
        text: markdown,
        html: html,
      };
      return msg;
    }
  );

  if (argv.dryRun) {
    _.forEach(emails, (email) => console.log(email.to, email.text));
  } else {
    await Promise.all(_.map(emails, sendEmail));
  }
}

main()
  .then(() => console.log("done"))
  .catch((e) => console.error(e));
