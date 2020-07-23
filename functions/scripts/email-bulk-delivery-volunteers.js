const functions = require('firebase-functions');
const _ = require('lodash');
const sgMail = require('@sendgrid/mail');
const showdown  = require('showdown');
const yargs = require('yargs');

sgMail.setApiKey(functions.config().sendgrid.api_key);

const { INTAKE_TABLE, VOLUNTEER_FORM_TABLE, getRecord, getRecordsWithStatus, getAllRecords, BULK_DELIVERY_ROUTES_TABLE } = require('../airtable');

const googleMapsUrl = (address) => (
  `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURI(address + ', Brooklyn, NY')}`
);

async function getBulkDeliveryConfirmedTickets() {
  return await getRecordsWithStatus(INTAKE_TABLE, 'Bulk Delivery Confirmed');
}

function getBulkRoute([, fields,]) {
  if (fields.bulkRoute.length !== 1) {
    throw new Error(`Ticket ${fields} does not have one Bulk Route`);
  }
  return fields.bulkRoute[0];
}

function groupTicketsByRoute(tickets) {
  return _.groupBy(tickets, getBulkRoute);
}

async function getDeliveryVolunteerInfo(route, tickets) {
  const volunteerIds = _.union(
    _.flatMap(tickets, ([, fields,]) => {
      if (!fields.deliveryVolunteer || fields.deliveryVolunteer.length !== 1) {
        throw new Error(`Ticket ${fields.ticketID} doesn't have exactly one volunteer: ${fields.deliveryVolunteer}`);
      }
      return fields.deliveryVolunteer;
    })
  );
  if (volunteerIds.length !== 1) {
    throw new Error(`Route ${route} doesn't have exactly one delivery volunteer: ${volunteerIds}`);
  }
  return await getRecord(VOLUNTEER_FORM_TABLE, volunteerIds[0]);
}

function renderEmail({ route, volunteer, arrivalTime }) {
  var email = `
Hi ${volunteer.Name.split(' ')[0]}!

Thank you for volunteering to deliver groceries to our neighbors with Bed-Stuy Strong!

We've assigned you the following tickets: ${_.join(_.map(route, 'ticketID'), ', ')}

### Instructions

This coming Saturday, please come to our warehouse at **[221 Glenmore Ave, Gate 4](${googleMapsUrl('221 Glenmore Ave')}) at ${arrivalTime}** to pick up your deliveries. Since there are perishables in the deliveries, you'll need to deliver them immediately after pickup.

You'll load your car with boxes for the above ticket IDs, and then deliver them to the addresses below. You may want to plan your route to Brooklyn Packers and then to the delivery locations in advance.

The neighbors you're delivering to have confirmed their availability for 1:30-4pm, but you'll call each of them before you leave the warehouse, to get any last minute delivery details. 

If possible, we recommend printing this email out so you can mark tickets done as you complete them, to fill out the [Completion Form](https://airtable.com/shrvHf4k5lRo0I8F4) at the end. If any issues come up during your deliveries, or you are unable to deliver any of the boxes (because someone isn't home) contact Jackson at (410) 402-3236. We'll help you redistribute the food to the community in another way. 

### Checklist
- [ ] Check in with Hanna or Jackson at the warehouse when you arrive. They'll let you know when your boxes are ready. While you're waiting:
- [ ] Call the recipients of each ticket to make sure they're available. If they're not, please let Jackson or Hanna know -- we'll use their items for someone else, and deliver to them another time. 
- [ ] At the warehouse, for each household get some of the following (we'll tell you):
    - [ ] Main food boxes (may be multiple per household)
    - [ ] Cleaning supplies
    - [ ] Custom items
    - [ ] Water
- [ ] Confirm all the ticket IDs match, and have your route number/name on them.
- [ ] Put everything in your car
- [ ] Check off each delivery below as you complete it
- [ ] Fill out the delivery completion form when you're done

----
### Tickets
  `;

  const tickets = route.map((ticket) => {
    let details = `\n
#### Ticket ID: ${ticket.ticketID}\n
- [ ] Confirmed someone will be home
- [ ] Delivered!

**Name**: ${ticket.requestName}<br />
**Address**: [${ticket.address}](${googleMapsUrl(ticket.address)})<br />
**Phone Number**: ${ticket.phoneNumber}<br />

**Vulnerabilities**: ${_.join(ticket.vulnerability, ', ')}<br />
**Household Size**: ${ticket.householdSize}<br />

**Grocery List**: ${_.join(ticket.foodOptions, ', ')}<br />
    `;
    if (ticket.otherItems !== null) {
      details += `**Custom Items**: ${ticket.otherItems}<br />`;
    }
    if (ticket.deliveryNotes !== null) {
      details += `\n\n**Notes for Delivery**: ${ticket.deliveryNotes}`;
    }
    return details;
  }).join('\n\n----\n');

  email += tickets;

  const converter = new showdown.Converter({
    tasklists: true,
  });
  const html = converter.makeHtml(email);

  const msg = {
    to: volunteer.email,
    cc: 'bedstuystrong+bulk@bedstuystrong.com',
    replyTo: 'bedstuystrong+bulk@bedstuystrong.com',
    from: functions.config().sendgrid.from,
    subject: `Bulk Delivery Prep and Instructions for ${volunteer.Name.split(' ')[0]}`,
    text: email,
    html: html,
  };

  return msg;
}

async function sendEmail(msg) {
  try {
    await sgMail.send(msg);
  } catch (error) {
    console.error(error);

    if (error.response) {
      console.error(error.response.body);
    }
  }
}

async function main() {
  const { argv } = yargs
    .option('route', {
      demandOption: false,
      describe: 'Email just one delivery volunteer for a specific route ID',
      type: 'string',
    })
    .boolean('dry-run');
  const allRoutes = await getAllRecords(BULK_DELIVERY_ROUTES_TABLE);
  const allBulkTickets = await getBulkDeliveryConfirmedTickets();
  const bulkTickets = argv.route ? _.filter(
    allBulkTickets,
    (ticket) => {
      const routeId = getBulkRoute(ticket);
      const route = _.find(allRoutes, ([id,,]) => { return id === routeId; });
      return route[1].name === String(argv.route);
    }
  ) : allBulkTickets;
  const routes = groupTicketsByRoute(bulkTickets);
  const assignedRoutes = await Promise.all(_.map(_.entries(routes), async ([routeId, route]) => (
    {
      route: _.map(route, ([, fields,]) => fields),
      volunteer: (await getDeliveryVolunteerInfo(routeId, route))[1],
      arrivalTime: _.find(allRoutes, ([id,,]) => { return id === routeId; }).arrivalTime,
    }
  )));
  const emails = _.map(assignedRoutes, renderEmail);
  if (argv.dryRun) {
    console.log(emails);
  } else {
    await Promise.all(_.map(emails, sendEmail));
  }
}

main().then(
  () => console.log('done')
).catch(
  (e) => console.error(e)
);
