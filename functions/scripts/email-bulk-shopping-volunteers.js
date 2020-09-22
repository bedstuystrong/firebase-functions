const functions = require('firebase-functions');
const fs = require('fs');
const _ = require('lodash');
const moment = require('moment');
const Mustache = require('mustache');
const yargs = require('yargs');

const { reconcileOrders, getAllRoutes } = require('../airtable');
const { Email, googleMapsUrl } = require('../messages');

async function main() {
  const { argv } = yargs
    .option('deliveryDate', {
      coerce: (x) => new Date(x),
      demandOption: true,
      describe: 'Date of scheduled delivery (yyyy-mm-dd format)',
    })
    .boolean('dryRun');

  // --------------------------------------------------------------------------
  // CUSTOMIZATION

  // Each week we might need custom shoppers to do some "bulk purchases" if we
  // couldn't procure everything we needed. The "no route" section lets us ask
  // every custom shopper to get some bulk items and not sort them by tickets.
  const noRouteSection = {
    items: []
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
      const { name } = fields;
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
      return { name, tickets };
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
      noRouteSection: _.isEmpty(noRouteSection.items) ? null : noRouteSection,
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
      replyTo: 'operations+bulk@bedstuystrong.com',
      subject: `[BSS Bulk Ordering] ${view.deliveryDateString} Delivery Prep and Instructions for ${view.firstName}`,
    });
  });

  if (argv.dryRun) {
    _.forEach(emails, (email) => {
      console.log('To:', email.render().to);
      console.log(email.render().text);
    });
  } else {
    await Promise.all(
      _.map(emails, (email) => {
        return email.send();
      })
    );
  }
  return null;
}

main()
  .then(() => console.log('done'))
  .catch((e) => console.error(e));
