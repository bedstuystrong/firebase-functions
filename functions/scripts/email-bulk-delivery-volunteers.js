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
    arrivalTime: route.arrivalTime,
    warehouseCoordinatorPhone: functions.config().bulk_ops_team.warehouse_coordinator.phone_number,
    tickets: ticketParameterMaps,
  };
}

async function main() {
  const usageText = 'Usage: $0 --delivery-date YYYY-MM-DD [OPTIONS]'
    + '\n\nSends an email to delivery volunteers registered to deliver on the specified delivery date, with instructions about delivery day, and the tickets assigned to them with information they will need.'
    + '\n\nIf you need to email just one volunteer, use --route to select one route number for that date.'
    + '\n\nWith --dry-run, the email content will be printed to the console.'
    + '\n\nTo include yourself in the Bcc list (to make sure the emails sent properly), pass --bcc.'
    + '\n\nPreconditions:'
    + '\n\n  This script reads the Bulk Delivery Routes table for the specified date, and looks up Delivery Volunteers assigned to those routes, and the Intake Tickets attached to those routes, so check those tables for correctness before running this.';
  const { argv } = yargs
    .option('deliveryDate', {
      coerce: (x) => new Date(x),
      demandOption: true,
      describe: 'Date of scheduled delivery (yyyy-mm-dd format)',
    })
    .option('route', {
      demandOption: false,
      describe: 'Send email for a specific route ID',
      type: 'string',
    })
    .option('bcc', {
      demandOption: false,
      describe: 'Add Bcc recipient(s) to all emails (comma separated)',
      type: 'string',
    })
    .boolean('dryRun')
    .usage(usageText);

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

  console.log('********************************************************************************\n\nNEXT STEPS!\n\nYou sent the delivery volunteers their coordination emails, they are all set to deliver! Great job!\n\n********************************************************************************');
}

main().then(
  () => console.log('done')
).catch(
  (e) => console.error(e)
);
