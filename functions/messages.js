const functions = require('firebase-functions');

const _ = require('lodash');

const { getTicketDueIn, getVolunteerSlackID } = require('./airtable');

const CHANNEL_IDS = functions.config().slack.channel_to_id;
const STATUS_TO_EMOJI = {
  'Seeking Volunteer': ':exclamation:',
  'Assigned / In Progress': ':woman-biking:',
  'Complete': ':white_check_mark:',
};

const safetyReminder = 'Reminder: Please don’t volunteer for delivery if you have any COVID-19/cold/flu-like symptoms, or have come into contact with someone that’s tested positive.';

/**
 * Get intake post content for a request's status
 */
async function getIntakePostContent(fields) {
  const intakeVolunteerSlackID = await getVolunteerSlackID(fields.intakeVolunteer);

  if (!intakeVolunteerSlackID) {
    console.error('Missing Intake Volunteer Slack ID', {
      ticket: fields.ticketID,
      volunteer: fields.intakeVolunteer,
    });
  }

  let content = `<@${intakeVolunteerSlackID}> got a new request from our neighbor ${fields.requestName}

*Status:* ${STATUS_TO_EMOJI[fields.status]} ${fields.status}\n`;

  if (fields.status !== 'Seeking Volunteer') {
    content += '*Assigned to*: ';

    const deliveryVolunteerslackID = await getVolunteerSlackID(fields.deliveryVolunteer);
    if (deliveryVolunteerslackID) {
      content += `<@${deliveryVolunteerslackID}>`;
    } else {
      content += ':question:';
    }
  }

  // Divides the status form the other info
  content += '\n';

  content += `*Ticket ID*: ${fields.ticketID}
*Nearest Intersection*: ${fields.nearestIntersection}
*Timeline*: ${fields.timeline}

*Want to help ${fields.requestName}?* Comment on this thread. :point_down:
`;

  return content;
}


/**
 * Get details to post in intake post's thread
 */
async function getIntakePostDetails(fields) {
  return `
*Need*: ${fields.category}
*Household Size*: ${fields.householdSize || ':question:'}
*Language*: ${fields.language}

*Description*: ${fields.description}
*Requested*: ${fields.items}
`;
}

/**
 * Get detailed message for delivery volunteers
 */
async function getDeliveryDMContent(fields) {
  const intakeVolunteerslackID = await getVolunteerSlackID(fields.intakeVolunteer);

  // TODO : gear the reimbursement flow towards delivery completion
  // TODO : error handling if volunteer id isn't present
  // TODO : don't send the volunteer this monstrosity of a message every time they take a delivery

  let content = `
<@${intakeVolunteerslackID}> assigned a request to you. Thanks so much for taking care of this delivery!

*Ticket ID*: ${fields.ticketID}`;

  // NOTE that it is a better user experience if we link to a thread, but we only have threads for new 
  // tickets, and backfilling them ended up being too much work
  const linkToTicket = fields.slackPostThreadLink || fields.slackPostLink;
  if (linkToTicket) {
    content += ` (<${linkToTicket}|_link to post_>)`;
  }
  content += '\n\n';

  content += `*Neighbor*: ${fields.requestName}
*Address*: ${fields.address}
*Delivery Notes*: ${fields.deliveryNotes || '_empty_'}
*Phone*: ${fields.phoneNumber}
*Timeline*: ${fields.timeline}
*Language*: ${fields.language}
*Special Conditions*: ${fields.vulnerability}

*Need*: ${fields.category}
*Description*: ${fields.description}
*Household Size*: ${fields.householdSize || '?'}
*Requested*: ${fields.items}\n`;

  // TODO : this is messy
  if (fields.householdSize) {
    content += '*Spending guidance:*\n';
    const householdSize = parseInt(fields.householdSize);

    if (householdSize <= 2) {
      content += '- $75/per person (1-2 ppl)\n';
    } else if (householdSize <= 5) {
      content += '- $250 for a medium household (3-5 ppl)\n';
    } else {
      content += '- $350 for a large household (6+ ppl)\n';
    }

    // NOTE that we want the next next message to be a bullet only if we have a 'Spending Guidance section'
    content += '- ';
  }

  content += 'Please try to buy about a week’s worth of food for the household. It’s ok if you can’t get every single thing on the shopping list--the main goal is that the family’s nutritional needs are sufficiently met.\n';

  content += `
*When you complete the delivery, please:*
- Take a photo of the receipt
- Fill out <https://airtable.com/shrvHf4k5lRo0I8F4|this completion form> to let us know that the delivery is completed. If you need reimbursement please fill out the reimbursement section, and you will be reimbursed from our community fund within 24 hours.
- For guidance on how to do a no-contact delivery, check out our <https://docs.google.com/document/d/1-sXwubRG3yBw2URDYcrSGZSj94tY_Ydk4xxVDmgRFh8/edit?usp=sharing|Delivery Volunteer FAQ guide>.

If you have any questions/problems, please post in <#${CHANNEL_IDS.delivery_volunteers}>. Thanks again for volunteering!

_${safetyReminder}_

:heart: :heart: :heart:`;

  return content;
}

async function getTicketSummaryBlocks(tickets, minDueDate = 3, maxNumTickets = 15) {
  if (tickets.length === 0) {
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '\nNo unassigned high priority tickets! Y\'all rule!!! :confetti_ball:',
      }
    };
  }

  let blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Delivery Request Summary*\n\n:fire: _Overdue!_, :warning: _Due Today_, :turtle: _< ${minDueDate} Days Left_`,
      }
    },
  ];

  const idToDueDate = _.zipObject(
    _.map(
      tickets,
      ([id, ,]) => id,
    ),
    _.map(
      tickets,
      ([, fields,]) => getTicketDueIn(fields),
    ),
  );

  // Tickets sorted by due date
  const sortedTickets = _.sortBy(
    tickets,
    ([id, ,]) => idToDueDate[id],
  );

  const neighborhoodToTickets = _.groupBy(
    sortedTickets,
    ([, fields,]) => fields.neighborhood,
  );

  const ticketIDsToInclude = _.slice(
    _.map(
      _.filter(
        sortedTickets,
        ([id, ,]) => idToDueDate[id] <= minDueDate,
      ),
      ([id, ,]) => id,
    ),
    0,
    maxNumTickets,
  );

  // Generate summaries for all neighborhoods
  for (const neighborhood in neighborhoodToTickets) {
    const neighborhoodTickets = neighborhoodToTickets[neighborhood];
    // NOTE that we only display tickets that are in the `maxNumSelected` truncated set
    const filteredNeighborhoodTickets = _.filter(neighborhoodTickets, ([id, ,]) => _.includes(ticketIDsToInclude, id));

    if (filteredNeighborhoodTickets.length === 0) {
      continue;
    }

    blocks.push(
      {
        type: 'divider',
      }
    );

    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${neighborhood}* _(${neighborhoodToTickets[neighborhood].length} Unassigned)_`,
        }
      }
    );

    // NOTE that we only display tickets that are in the `maxNumSelected` truncated set
    for (const [id, fields,] of filteredNeighborhoodTickets) {
      const dueDate = idToDueDate[id];

      let urgencyEmoji;
      if (dueDate < 0) {
        urgencyEmoji = ':fire:';
      } else if (dueDate < 1) {
        urgencyEmoji = ':warning:';
      } else {
        urgencyEmoji = ':turtle:';
      }

      let ticketContent = `${urgencyEmoji} *${fields.ticketID}* (${fields.nearestIntersection}) [household of ${fields.householdSize}]`;

      // NOTE that it is a better user experience if we link to a thread, but we only have threads for new 
      // tickets, and backfilling them ended up being too much work
      const link = fields.slackPostThreadLink || fields.slackPostLink;
      if (link) {
        ticketContent += `: <${link}|_link to post_>`;
      }

      blocks.push(
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ticketContent
          }
        }
      );
    }
  }

  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `If you would like to claim one of these deliveries, please comment on the ticket thread by following the _link to post_, or reach out in <#${CHANNEL_IDS.delivery_volunteers}>`
      }
    }
  );

  return blocks;
}

module.exports = {
  getDeliveryDMContent,
  getIntakePostContent,
  getIntakePostDetails,
  getTicketSummaryBlocks,
};