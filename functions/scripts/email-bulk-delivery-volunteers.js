const functions = require('firebase-functions');
const _ = require('lodash');
const fs = require('fs');
const moment = require('moment');
const Mustache = require('mustache');
const yargs = require('yargs');

const { getAllRoutes, getTicketsForRoutes, getRecordsWithFilter, BULK_DELIVERY_ROUTES_TABLE } = require('../airtable');
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

  const templateParameterMaps = await Promise.all(_.map(routes, async (route) => {
    const ticketRecords = await getTicketsForRoutes([route]);
    const ticketsFields = _.map(ticketRecords, ([, fields,]) => fields);
    const [, routeFields,] = route;
    return getEmailTemplateParameters(routeFields, ticketsFields);
  }));

  const templateFilename = 'functions/templates/bulk-delivery-volunteer-email.md.mustache';
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
