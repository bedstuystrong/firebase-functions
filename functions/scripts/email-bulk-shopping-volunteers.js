const functions = require('firebase-functions');
const fs = require('fs');
const _ = require('lodash');
const moment = require('moment');
const Mustache = require('mustache');
const yargs = require('yargs');

const { reconcileOrders, getAllRoutes } = require('../airtable');
const { Email, googleMapsUrl } = require('../messages');

async function main() {
  const usageText = 'Usage: $0 --delivery-date YYYY-MM-DD [OPTIONS]'
    + '\n\nSends an email to shopping volunteers registered to do custom shopping on the specified delivery date, with instructions about delivery day, and shopping lists for the tickets assigned to them.'
    + '\n\nWith --dry-run, the email content will be printed to the console.'
    + '\n\nTo include yourself in the Bcc list (to make sure the emails sent properly), pass --bcc.'
    + '\n\nPreconditions:'
    + '\n\n  This script reads the Bulk Delivery Routes table for the specified date, and looks up Shopping Volunteers assigned to those routes, and the Intake Tickets attached to those routes, so check those tables for correctness before running this.'
    + '\n\n  This script also reads the Bulk Order table to compare it with the total groceries requested in tickets scheduled for bulk delivery, to determine what extra items we did not procure, which shoppers need to fulfill, so check to make sure that table has been updated to reflect the actually procured bulk items before running this.'
    + '\n\n  You should run this together with generate-packing-slips.js, so that the shopping lists for shopping volunteers accurately match the items in the Other category on the packing slips.'
    + '\n\n    You should probably run this in --dry-run mode, and generate the packing slips, and check at least a few tickets to make sure that the shopping lists match the Other category on the packing slips, before sending the packing slips to Brooklyn Packers or the shopping lists to our Shopping Volunteers.'
    + '\n\n  Finally, check with the Bulk Delivery Coordinator for this week to find out if there are any special items this week---either bulk items we need Shopping Volunteers to fill in the gaps on, or custom items we can actually provide in a bulk-like way that are not in the Bulk Order table. Check the source code for this script, there is a "CUSTOMIZATION" section you may need to edit in that case.';
  const { argv } = yargs
    .option('deliveryDate', {
      coerce: (x) => new Date(x),
      demandOption: true,
      describe: 'Date of scheduled delivery (yyyy-mm-dd format)',
    })
    .option('bcc', {
      demandOption: false,
      describe: 'Add Bcc recipient(s) to all emails (comma separated)',
      type: 'string',
    })
    .boolean('dryRun')
    .usage(usageText);

  // --------------------------------------------------------------------------
  // CUSTOMIZATION

  // Each week we might need custom shoppers to do some "bulk purchases" if we
  // couldn't procure everything we needed. The "no route" section lets us ask
  // every custom shopper to get some bulk items and not sort them by tickets.
  const noRouteSection = {
    items: [
      {
        item: 'Chicken: 9 individual 2 pound packs<br/>\n   Don\'t sort this chicken by ticket, just put all chicken together in a single bag, and hand directly to Hanna or Jackson for cold storage and packing.'
      }
    ]
  };

  /**
   * Sometimes, we have "custom items" we have on hand and don't need shoppers
   * to purchase, but they aren't represented in the Bulk Order table.
   * @param {{ item: string, quantity: number | null }} param0 Custom item.
   */
  const itemNeedsCustomShopping = ({ item }) => {
    return !(_.endsWith(item, 'art kit') || _.endsWith(item, 'art kits'));
  };

  // END CUSTOMIZATION
  // --------------------------------------------------------------------------

  const allRoutes = await getAllRoutes(argv.deliveryDate);

  const routesMissingShoppingVolunteer = _.filter(allRoutes, ([, fields]) => {
    return fields.shoppingVolunteer === null;
  });
  if (!_.isEmpty(routesMissingShoppingVolunteer)) {
    const msg = 'Some routes are missing a shopping volunteer';
    console.error(msg, routesMissingShoppingVolunteer);
    throw new Error(msg);
  }

  const routesByShopper = _.groupBy(allRoutes, ([, fields]) => {
    return fields.shoppingVolunteerEmail[0];
  });

  const orders = await reconcileOrders(argv.deliveryDate, allRoutes);

  const ordersByKey = _.fromPairs(
    _.map(orders, (order) => {
      return [order.intakeRecord[0], order];
    })
  );

  const templateParameterMaps = _.map(_.values(routesByShopper), (routes) => {
    const sortedRoutes = _.sortBy(routes, ([, fields]) => fields.name);

    const routeParameters = _.map(sortedRoutes, ([, fields]) => {
      const { routeName } = fields;
      const orders = _.sortBy(
        _.map(fields.intakeTickets, (ticketKey) => {
          return ordersByKey[ticketKey];
        }),
        (order) => {
          return order.intakeRecord[1].ticketID;
        }
      );
      const allTicketParameters = _.map(orders, (order) => {
        const { ticketID, vulnerability, householdSize } = order.intakeRecord[1];
        const conditions = _.concat([`household size ${householdSize}`], vulnerability);
        const items = _.filter(order.getAdditionalItems(), itemNeedsCustomShopping);
        return { ticketID, conditions: _.join(conditions, ', '), items };
      });
      const tickets = _.filter(allTicketParameters, ({ items }) => {
        return items.length > 0;
      });
      return { name: routeName, tickets };
    });

    const { shoppingVolunteerEmail, shoppingVolunteerName } = routes[0][1];
    const firstName = shoppingVolunteerName[0].split(' ')[0];
    const deliveryDateString = moment(argv.deliveryDate).utc().format('MMMM Do');
    const warehouseMapsUrl = googleMapsUrl('221 Glenmore Ave');
    const warehouseCoordinatorPhone = functions.config().bulk_ops_team.warehouse_coordinator.phone_number;

    return {
      to: shoppingVolunteerEmail,
      firstName,
      deliveryDateString,
      warehouseMapsUrl,
      warehouseCoordinatorPhone,
      noRouteSection,
      routes: routeParameters,
    };
  });

  const templateFilename = 'functions/templates/bulk-shopping-volunteer-email.md.mustache';
  const template = (await fs.promises.readFile(templateFilename)).toString('utf-8');

  const emails = _.map(templateParameterMaps, (view) => {
    const markdown = Mustache.render(template, view);

    return new Email(markdown, {
      to: view.to,
      cc: 'operations+bulk@bedstuystrong.com',
      bcc: _.map(_.split(argv.bcc || '', ','), (address) => _.trim(address)),
      replyTo: 'operations+bulk@bedstuystrong.com',
      subject: `[BSS Bulk Ordering] ${view.deliveryDateString} Delivery Prep and Instructions for ${view.firstName}`,
    });
  });

  if (argv.dryRun) {
    _.forEach(emails, (email) => console.log(email.render()));
  } else {
    await Promise.all(_.map(emails, (email) => {
      return email.send();
    }));
  }
  console.log('********************************************************************************\n\nNEXT STEPS!\n\nYou sent the shopping volunteers their coordination emails, they are all set to go shopping! Great job!\n\n********************************************************************************');
}

main()
  .then(() => console.log('done'))
  .catch((e) => console.error(e));
