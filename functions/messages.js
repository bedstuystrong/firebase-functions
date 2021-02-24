const functions = require('firebase-functions');

const sgMail = require('@sendgrid/mail');
const showdown = require('showdown');
const _ = require('lodash');

const { BULK_DELIVERY_STATUSES } = require('./schema');
const {
  getTicketDueIn,
  getVolunteerSlackID,
  getItemsByHouseholdSize,
} = require('./airtable');

const CHANNEL_IDS = functions.config().slack.channel_to_id;
const STATUS_TO_EMOJI = {
  'Seeking Volunteer': ':exclamation:',
  'Bulk Delivery Scheduled': ':package:',
  'Bulk Delivery Confirmed': ':package:',
  'Assigned / In Progress': ':woman-biking:',
  'Complete': ':white_check_mark:',
};

sgMail.setApiKey(functions.config().sendgrid.api_key);

const safetyReminder =
  'Reminder: Please don’t volunteer for delivery if you have any COVID-19/cold/flu-like symptoms, or have come into contact with someone that’s tested positive.';

function googleMapsUrl(address) {
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURI(`${address}, Brooklyn, NY`)}`;
}

/**
 * Get intake post content for a request's status
 */
async function getIntakePostContent(fields) {
  const intakeVolunteerSlackID = await getVolunteerSlackID(
    fields.intakeVolunteer
  );

  if (!intakeVolunteerSlackID) {
    console.error('Missing Intake Volunteer Slack ID', {
      ticket: fields.ticketID,
      volunteer: fields.intakeVolunteer,
    });
  }

  let content = `<@${intakeVolunteerSlackID}> got a new request from our neighbor ${
    fields.requestName
  }

*Status:* ${STATUS_TO_EMOJI[fields.status]} ${fields.status}\n`;

  if (_.includes(BULK_DELIVERY_STATUSES, fields.status)) {
    content += '*No volunteer needed*: This will be part of the next bulk delivery!';
  } else if (fields.status !== 'Seeking Volunteer') {
    content += '*Assigned to*: ';

    const deliveryVolunteerslackID = await getVolunteerSlackID(
      fields.deliveryVolunteer
    );
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
  const itemsDesc = !_.isNull(fields.items)
    ? fields.items
    : _.join(fields.foodOptions, ', ') + '.';

  let content = `
*Household Size*: ${fields.householdSize || ':question:'}
*Language*: ${fields.language}
*Can meet outside?*: ${fields.canMeetOutside}

*Description*: ${fields.description}
*Requested*: ${itemsDesc}\n`;

  if (!_.isNull(fields.otherItems)) {
    content += `*Other Items*: ${fields.otherItems}\n`;
  }

  return content;
}

/**
 * Get detailed message for delivery volunteers
 */
async function getDeliveryDMContent(fields) {
  const intakeVolunteerslackID = await getVolunteerSlackID(
    fields.intakeVolunteer
  );

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

  const itemsDesc = !_.isNull(fields.items)
    ? fields.items
    : _.join(fields.foodOptions, ', ') + '.';

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
*Requested*: ${itemsDesc}\n`;

  if (!_.isNull(fields.otherItems)) {
    content += `*Other Items*: ${fields.otherItems}\n`;
  }

  // TODO : this is messy
  if (fields.householdSize) {
    content += '*Spending guidance:*\n';
    const householdSize = parseInt(fields.householdSize);

    if (householdSize === 1) {
      content += '- $100 for a 1-person household\n';
    } else if (householdSize === 2) {
      content += '- $150 for a 2-person household\n';
    } else if (householdSize <= 5) {
      content += '- $250 for a medium household (3-5 ppl)\n';
    } else {
      content += '- $350 for a large household (6+ ppl)\n';
    }

    // NOTE that we want the next message to be a bullet only if we have a 'Spending Guidance section'
    content += '- ';
  }

  content +=
    'Please try to buy about a week’s worth of food for the household. It’s ok if you can’t get every single thing on the shopping list--the main goal is that the family’s nutritional needs are sufficiently met.\n';

  const epilogue = `
*When you complete the delivery, please:*
- Take a photo of the receipt
- Fill out <https://airtable.com/shrvHf4k5lRo0I8F4|this completion form> to let us know that the delivery is completed. If you need reimbursement please fill out the reimbursement section, and you will be reimbursed from our community fund within 24 hours.
- For guidance on how to do a no-contact delivery, check out our <https://docs.google.com/document/d/1-sXwubRG3yBw2URDYcrSGZSj94tY_Ydk4xxVDmgRFh8/edit?usp=sharing|Delivery Volunteer FAQ guide>.

If you have any questions/problems, please post in <#${CHANNEL_IDS.delivery_volunteers}>. Thanks again for volunteering!

_${safetyReminder}_

:heart: :heart: :heart:`;

  // We split the content into two separate sections because each section has a
  // max length of 3000 characters, and some tickets have long delivery notes or
  // things that cause us to overflow that. Breaking the epilogue into a
  // separate section makes it more likely that both sections will be under 3000
  // characters.
  return [content, epilogue];
}

const renderDeliveryDM = (ticketID, [deliveryDMContent, deliveryDMEpilogue], deliveryChannel) => (
  {
    channel: deliveryChannel,
    as_user: true,
    text: `${deliveryDMContent}\n${deliveryDMEpilogue}`, // fallback for blocks section
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: deliveryDMContent
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: deliveryDMEpilogue
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Email me this shopping list'
            },
            style: 'primary',
            action_id: 'email_shopping_list',
            value: ticketID
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'One list for all my tickets'
            },
            action_id: 'email_consolidated_shopping_list'
          }
        ]
      }
    ],
    unfurl_media: false,
    unfurl_links: false,
  }
);

async function getShoppingList(tickets) {
  const itemsByHouseholdSize = await getItemsByHouseholdSize();
  const categorizedStandardFoodOptions = ([, fields]) => {
    return _.fromPairs(
      _.map(fields.foodOptions, (item) => [
        item,
        {
          category: (itemsByHouseholdSize[item]) ? itemsByHouseholdSize[item].category : 'Custom',
          amounts: {
            ticket: fields.ticketID,
            quantity: (itemsByHouseholdSize[item]) ? itemsByHouseholdSize[item][fields.householdSize] : 'custom',
          },
          unit: (itemsByHouseholdSize[item]) ? itemsByHouseholdSize[item].unit : 'custom',
        },
      ])
    );
  };
  const addAmounts = (item, acc, amounts) => {
    return _.get(acc, item, { amounts: [] }).amounts.concat([amounts]);
  };
  const totalCategorizedStandardFoodOptions = _.reduce(
    _.map(tickets, categorizedStandardFoodOptions),
    (acc, groups) => {
      const updates = _.fromPairs(
        _.map(_.entries(groups), ([item, { category, amounts, unit }]) => [
          item,
          {
            category,
            amounts: addAmounts(item, acc, amounts),
            unit,
          },
        ])
      );
      return Object.assign(acc, updates);
    },
    {}
  );
  const flattened = _.map(_.entries(totalCategorizedStandardFoodOptions), ([item, { category, amounts, unit }]) => ({ item, category, amounts, unit }));
  return _.groupBy(flattened, 'category');
}

const renderShoppingList = (groups) => {
  var shoppingList = '';
  for (const [group, items] of _.entries(groups)) {
    shoppingList += `\n## ${group}:\n\n`;
    for (const { item, amounts, unit } of items) {
      const howMuch = _.join(_.map(amounts, ({ ticket, quantity }) => `  - [ ] ${quantity} for ${ticket}`), '\n');
      shoppingList += `* ${item} (${unit}):\n${howMuch}`;
      shoppingList += '\n';
    }
  }
  return shoppingList;
};

const renderSingleTicketShoppingList = (groups) => {
  var shoppingList = '';
  for (const [group, items] of _.entries(groups)) {
    shoppingList += `\n#### ${group}:\n\n`;
    for (const { item, amounts, unit } of items) {
      shoppingList += `- [ ] ${amounts[0].quantity} ${unit} ${item}\n`;
    }
  }
  return shoppingList;
};

async function getTicketSummaryBlocks(
  tickets,
  minDueDate = 3,
  maxNumTickets = 15
) {
  if (tickets.length === 0) {
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '\nNo unassigned high priority tickets! Y\'all rule!!! :confetti_ball:',
      },
    };
  }

  const quadrantHeartColors = {
    NE: ':purple_heart:',
    SE: ':blue_heart:',
    NW: ':orange_heart:',
    SW: ':green_heart:',
  };

  const quadrantNames = {
    NE: 'NORTHEAST',
    SE: 'SOUTHEAST',
    NW: 'NORTHWEST',
    SW: 'SOUTHWEST',
  };

  let blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Delivery Request Summary*',
      }
    }
  ];

  const idToDueDate = _.zipObject(
    _.map(tickets, ([id, ,]) => id),
    _.map(tickets, ([, fields]) => getTicketDueIn(fields))
  );

  // Tickets sorted by due date
  const sortedTickets = _.sortBy(tickets, ([id, ,]) => idToDueDate[id]);

  const neighborhoodToTickets = _.groupBy(
    sortedTickets,
    ([, fields]) => fields.neighborhood
  );

  const ticketIDsToInclude = _.slice(
    _.map(
      _.filter(sortedTickets, ([id, ,]) => idToDueDate[id] <= minDueDate),
      ([id, ,]) => id
    ),
    0,
    maxNumTickets
  );

  // Generate summaries for all neighborhoods
  for (const neighborhood in neighborhoodToTickets) {
    const neighborhoodTickets = neighborhoodToTickets[neighborhood];
    // NOTE that we only display tickets that are in the `maxNumSelected` truncated set
    const filteredNeighborhoodTickets = _.filter(
      neighborhoodTickets,
      ([id, ,]) => _.includes(ticketIDsToInclude, id)
    );

    if (filteredNeighborhoodTickets.length === 0) {
      continue;
    }

    blocks.push({
      type: 'divider',
    });

    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${quadrantNames[neighborhood]}*`,
        }
      }
    );

    const ticketsByUrgency = _.groupBy(filteredNeighborhoodTickets, ([id]) => {
      const dueDate = idToDueDate[id];
      if (dueDate < 0) {
        return 'Overdue';
      } else if (dueDate < 1) {
        return 'Due Today';
      } else {
        return 'Not Due Today';
      }
    });

    const urgencyEmoji = {
      'Overdue': ':fire:',
      'Due Today': ':warning:',
      'Not Due Today': ':turtle:',
    };

    const relevantUrgencies = _.filter(
      ['Overdue', 'Due Today', 'Not Due Today'],
      (urgency) => { return ticketsByUrgency[urgency]; },
    );

    _.forEach(relevantUrgencies, (urgency) => {
      blocks.push(
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${urgencyEmoji[urgency]} ${ticketsByUrgency[urgency].length} _${urgency}_`,
          }
        }
      );
  
      _.forEach(ticketsByUrgency[urgency], ([, fields,]) => {
        // NOTE that it is a better user experience if we link to a thread, but we only have threads for new 
        // tickets, and backfilling them ended up being too much work
        const link = fields.slackPostThreadLink || fields.slackPostLink;
    
        const ticketContent = `${quadrantHeartColors[neighborhood]} <${link}|*${fields.ticketID}*> (${fields.nearestIntersection}) [household of ${fields.householdSize}]`;
    
        blocks.push(
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ticketContent
            }
          }
        );
      });
    });
  }

  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `If you would like to claim one of these deliveries please reach out in <#${CHANNEL_IDS.delivery_volunteers}>`
      }
    }
  );

  return blocks;
}

class Email {
  constructor(markdown, options) {
    this.markdown = markdown;
    this.options = options;
  }

  render() {
    const converter = new showdown.Converter({ tasklists: true });
    const html = converter.makeHtml(this.markdown);
    return Object.assign({}, this.options, {
      from: functions.config().sendgrid.from,
      text: this.markdown,
      html: html,
    });
  }

  async send() {
    return await sgMail.send(this.render());
  }
}

module.exports = {
  getDeliveryDMContent,
  getIntakePostContent,
  getIntakePostDetails,
  getTicketSummaryBlocks,
  googleMapsUrl,
  Email,
  getShoppingList,
  renderShoppingList,
  renderSingleTicketShoppingList,
  renderDeliveryDM
};
