const functions = require('firebase-functions');
const _ = require('lodash');
const fs = require('fs');
const moment = require('moment');
const Mustache = require('mustache');
const showdown = require('showdown');
const yargs = require('yargs');

const { getAllRoutes, getTicketsForRoutes, getRecordsWithFilter, reconcileOrders, BULK_DELIVERY_ROUTES_TABLE } = require('../airtable');
const { googleMapsUrl, Email } = require('../messages');

function getEmailTemplateParameters(route, tickets) {
  const ticketParameterMaps = tickets.map((ticket) => {
    return Object.assign({}, ticket, {
      phoneNumberNumbersOnly: _.replace(ticket.phoneNumber, /[^0-9]/g, ''),
      mapsUrl: googleMapsUrl(ticket.address),
      vulnerabilities: _.join(ticket.vulnerability, ', '),
      groceryList: _.join(ticket.foodOptions, ', '),
    });
  });
  return {
    to: route.deliveryVolunteerEmail,
    deliveryDateString: moment(route.deliveryDate).utc().format('MMMM Do'),
    firstName: route.deliveryVolunteerName[0].split(' ')[0],
    routeName: route.name,
    ticketIDs: _.join(_.map(tickets, (fields) => {
      return fields.ticketID;
    }), ', '),
    warehouseMapsUrl: googleMapsUrl('221 Glenmore Ave'),
    arrivalTime: _.trim(route.arrivalTime),
    warehouseCoordinatorPhone: functions.config().bulk_ops_team.warehouse_coordinator.phone_number,
    tickets: ticketParameterMaps,
  };
}

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
  const lowered = _.lowerCase(item);
  return !(
    _.endsWith(lowered, 'art kit')
    || _.endsWith(lowered, 'art kits')
    || lowered.match(/\d\s*books?\s/) !== null
    || _.endsWith(lowered, 'bike helmet')
    || _.endsWith(lowered, 'bike helmets')
  );
};

const getShoppingListTemplateParameters = (route, orders) => {
  const allTickets = _.map(orders, (order) => {
    const { ticketID, vulnerability, householdSize } = order.intakeRecord[1];
    const conditions = _.concat([`household size ${householdSize}`], vulnerability);
    const items = _.filter(order.getAdditionalItems(), itemNeedsCustomShopping);
    return { ticketID, conditions: _.join(conditions, ', '), items };
  });
  const tickets = _.filter(allTickets, ({ items }) => {
    return items.length > 0;
  });
  const params = {
    routeName: route.name,
    tickets
  };
  if (!_.isEmpty(noRouteSection.items)) {
    params.noRouteSection = noRouteSection;
  }
  return params;
};

async function main() {
  const { argv } = yargs
    .option('deliveryDate', {
      coerce: (x) => new Date(x),
      demandOption: true,
      describe: 'Date of scheduled delivery (yyyy-mm-dd format)',
    })
    .option('route', {
      coerce: String,
      demandOption: false,
      describe: 'Email just one delivery volunteer for a specific route ID',
      type: 'string',
    })
    .boolean('dryRun');

  const routes = argv.route ? (
    await getRecordsWithFilter(BULK_DELIVERY_ROUTES_TABLE, { deliveryDate: argv.deliveryDate, name: argv.route })
  ) : await getAllRoutes(argv.deliveryDate);

  const orders = await reconcileOrders(argv.deliveryDate, routes);

  const ordersByKey = _.fromPairs(
    _.map(orders, (order) => {
      return [order.intakeRecord[0], order];
    })
  );

  const templateParameterMaps = await Promise.all(_.map(routes, async (route) => {
    const ticketRecords = await getTicketsForRoutes([route]);
    const ticketsFields = _.map(ticketRecords, ([, fields,]) => fields);
    const [, routeFields,] = route;
    const orders = _.sortBy(
      _.map(ticketRecords, ([ticketKey,]) => {
        return ordersByKey[ticketKey];
      }),
      (order) => {
        return order.intakeRecord[1].ticketID;
      }
    );
    return {
      email: getEmailTemplateParameters(routeFields, ticketsFields),
      shoppingList: getShoppingListTemplateParameters(routeFields, orders)
    };
  }));

  const emailTemplateFilename = 'functions/templates/bulk-delivery-volunteer-email.md.mustache';
  const emailTemplate = (await fs.promises.readFile(emailTemplateFilename)).toString('utf-8');

  const shoppingListTemplateFilename = 'functions/templates/bulk-shopping-volunteer-email.md.mustache';
  const shoppingListTemplate = (await fs.promises.readFile(shoppingListTemplateFilename)).toString('utf-8');

  const emails = _.map(templateParameterMaps, ({ email: emailView, shoppingList: shoppingListView }) => {
    const markdown = Mustache.render(emailTemplate, emailView);
    const shoppingListMarkdown = Mustache.render(shoppingListTemplate, shoppingListView);
    const converter = new showdown.Converter({ tasklists: true });
    const shoppingList = converter.makeHtml(shoppingListMarkdown);
    return new Email(markdown, {
      to: emailView.to,
      cc: 'operations+bulk@bedstuystrong.com',
      replyTo: 'operations+bulk@bedstuystrong.com',
      subject: `[BSS Bulk Ordering] ${emailView.deliveryDateString} Delivery Prep and Instructions for ${emailView.firstName}`,
      attachments: [
        {
          content: Buffer.from(shoppingList).toString('base64'),
          filename: 'shopping-list.html',
          type: 'text/html',
          disposition: 'attachment'
        }
      ]
    });
  });

  if (argv.dryRun) {
    _.forEach(emails, (email) => {
      console.log('To:', email.render().to);
      console.log(email.render().text);
    });
  } else {
    await Promise.all(_.map(emails, (email) => {
      return email.send();
    }));
  }
}

main().then(
  () => console.log('done')
).catch(
  (e) => console.error(e)
);
