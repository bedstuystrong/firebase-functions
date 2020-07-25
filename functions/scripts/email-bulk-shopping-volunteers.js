const functions = require('firebase-functions');
const fs = require('fs');
const _ = require('lodash');
const yargs = require('yargs');

const { getPackingSlips, getAllRoutes } = require('../airtable');
const { Email, googleMapsUrl } = require('../messages');
const moment = require('moment');
const Mustache = require('mustache');

async function main() {
  const { argv } = yargs
    .option('delivery-date', {
      coerce: (x) => new Date(x),
      demandOption: true,
      describe: 'Date of scheduled delivery (yyyy-mm-dd format)',
    })
    .boolean('dry-run');

  const allRoutes = await getAllRoutes(argv.deliveryDate);

  const routesByShopper = _.groupBy(
    _.filter(allRoutes, ([, fields]) => fields.shoppingVolunteer !== null),
    ([, fields]) => {
      return fields.shoppingVolunteerEmail[0];
    }
  );

  const packingSlips = await getPackingSlips(allRoutes, argv.deliveryDate);

  const packingSlipsById = _.fromPairs(
    _.map(packingSlips, (slip) => {
      return [slip.intakeRecord[0], slip];
    })
  );

  const getTemplateVariables = ([shoppingVolunteer, routes]) => {
    _.forEach(routes, ([, fields,]) => {
      if (fields.shoppingVolunteerEmail[0] !== shoppingVolunteer) {
        throw new Error(`Mismatched shopping volunteer email, expected ${shoppingVolunteer}, got ${shoppingVolunteerEmail[0]}`);
      }
    });
    const noRouteSection = {
      items: [
        {
          item: 'Chicken: 9 individual 2 pound packs<br/>\n   Don\'t sort this chicken by ticket, just put all chicken together in a single bag, and hand directly to Hanna or Jackson for cold storage and packing.'
        }
      ]
    };
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
    const routeVariables = _.map(slipsByRoute, ([routeName, slips]) => {
      const allTickets = _.map(
        _.sortBy(slips, (slip) => slip.intakeRecord[1].ticketID),
        (slip) => {
          const { ticketID, vulnerability, householdSize } = slip.intakeRecord[1];
          const conditions = _.concat([`household size ${householdSize}`], vulnerability);
          const items = _.map(
            _.filter(slip.getAdditionalItems(), ([item]) => {
              return !(_.endsWith(item, 'art kit') || _.endsWith(item, 'art kits'));
            }),
            ([item, quantity]) => ({ item, quantity })
          );
          return { ticketID, conditions: _.join(conditions, ', '), items };
        }
      );
      const tickets = _.filter(allTickets, ({ items }) => items.length > 0);
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
      routes: routeVariables,
    };
  };

  const views = _.map(_.entries(routesByShopper), getTemplateVariables);

  const template = (await fs.promises.readFile('functions/templates/bulk-shopping-volunteer-email.md.mustache')).toString('utf-8');

  const makeEmails = (view) => {
    const markdown = Mustache.render(template, view);

    return new Email(markdown, {
      to: view.to,
      cc: 'operations+bulk@bedstuystrong.com',
      replyTo: 'operations+bulk@bedstuystrong.com',
      subject: `[BSS Bulk Ordering] ${view.deliveryDateString} Delivery Prep and Instructions for ${view.firstName}`,
    });
  };

  const emails = _.map(views, makeEmails);

  if (argv.dryRun) {
    _.forEach(emails, (email) => console.log(email.render()));
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
