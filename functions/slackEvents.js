const functions = require('firebase-functions');
const fetch = require('node-fetch');
const Slack = require('slack');
const _ = require('lodash');

const emailDomain = functions.config().sendgrid.from_domain;

const CHANNEL_IDS = functions.config().slack.channel_to_id;

const bot = new Slack({ token: functions.config().slack.token });

const {
  INTAKE_TABLE,
  getRecordsWithTicketID,
  getVolunteerBySlackID,
  getRecordsWithFilter,
} = require('./airtable');

const {
  getShoppingList,
  renderShoppingList,
  renderSingleTicketShoppingList,
  Email,
} = require('./messages');

// To test locally:
// Use the Volunteer Bot (DEV) slackbot, set its xoxb token in your runtime config
// along with your own slack user id as the test user id
// start the emulators with firebase emulators:start
// start an ngrok session against the functions port
// e.g. if functions have started on localhost:5001, ngrok http 5001
// set the slack events url to https://<ngrok address>/project-id/region/function-name
// e.g. https://<numbers>.ngrok.io/bedstuystrong-automation-<stuff>/us-central1/slackEvents-main
module.exports = {
  main: functions.https.onRequest(async (req, res) => {
    console.log('Handling slack event', { type: req.body.type });

    if (req.body.type === 'url_verification') {
      res.send(req.body.challenge);
      return;
    }

    if (req.body.type === 'event_callback') {
      await triageEvent(req.body.event);
    } else {
      console.error('Encountered an unsupported request type', { type: req.body.type });
    }

    res.sendStatus(200);
  }),

  interactions: functions.https.onRequest(async (req, res) => {
    console.log('Handling slack interaction');

    let payload;
    try {
      payload = JSON.parse(req.body.payload);
    } catch (err) {
      console.error('Unable to parse interaction payload', { error: err, payload: req.body.payload });
      res.status(500).end();
      return;
    }

    // Ack immediately with a 200, use response_url to follow up later
    res.status(200).end();

    const sendFailureMessage = async (url) => {
      await sendMessageToSlackResponseUrl(url, {
        replace_original: false,
        text: 'Oops. Something went wrong.'
      });
    };

    if (payload.type !== 'block_actions') {
      console.error('Encountered an unsupported interaction type', { type: payload.type });
      sendFailureMessage(payload.response_url);
      return;
    }

    // Slack interactions can have multiple interactive components, and thus multiple actions
    // currently, however, we only have one action
    const status = await handleAction(payload.actions[0], payload.user);

    if (status === 0) {
      sendMessageToSlackResponseUrl(payload.response_url, {
        replace_original: false,
        text: 'Your email is on its way! (if you don\'t see it shortly, check your spam folder.)',
      });
    } else {
      sendFailureMessage(payload.response_url);
    }
  })
};

async function triageEvent(event) {
  if (event.type === 'message') {
    await onMessageEvent(event);
  } else {
    console.error('Encountered an unsupported event type', { type: event.type });
  }
}

async function onMessageEvent(event) {
  console.log('onMessageEvent', { event: event });

  // NOTE that we ignore all messages:
  // - with subtypes (e.g. `message_changed`)
  // - that weren't posted in the tickets channel
  // - or aren't thread replies
  if (
    event.subtype ||
    event.channel !== CHANNEL_IDS.tickets ||
    !event.thread_ts
  ) {
    return;
  }

  const repliesRes = await bot.conversations.replies({
    channel: event.channel,
    ts: event.thread_ts,
  });

  // NOTE that we only want to notify #tickets_activity with the first message in a thread
  // NOTE that the first message is always the post itself, and the second is the bot's follow up
  if (repliesRes.messages.length < 3 || repliesRes.messages[2].ts !== event.ts) {
    return;
  }

  const linkRes = await bot.chat.getPermalink({
    channel: event.channel,
    message_ts: event.ts,
  });

  console.log('onMessageEvent: sharing comment in tickets activity channel');

  await bot.chat.postMessage({
    channel: CHANNEL_IDS.tickets_activity,
    text: `<@${event.user}> commented on a thread in <#${event.channel}>: _<${linkRes.permalink}|link to comment>_`,
  });
}

async function handleAction(action, user) {
  const [volunteerKey, volunteer] = await getVolunteerBySlackID(user.id);
  if (!volunteer) {
    throw new Error(`No volunteer found for slack id ${user.id}`);
  }

  switch (action.action_id) {
  case 'email_shopping_list':
    try {
      const records = await getRecordsWithTicketID(INTAKE_TABLE, action.value);
      validateVolunteerAssigned(records, volunteerKey);
      const email = await getSingleShoppingListEmail(records, volunteer);
      email.send();
    } catch (err) {
      console.error('Failed to email shopping list to user', { user: user.id, err: err });
      return 1;
    }

    return 0;
  case 'email_consolidated_shopping_list':
    try {
      const records = await getRecordsWithFilter(INTAKE_TABLE, {
        status: 'Assigned / In Progress',
        deliveryVolunteer: volunteerKey
      });
      validateVolunteerAssigned(records, volunteerKey);
      const email = await getConsolidatedShoppingListEmail(records, volunteer);
      email.send();
    } catch (err) {
      console.error('Failed to email shopping list to user', { user: user.id, err: err });
      return 1;
    }

    return 0;
  default:
    console.error('Encountered an unsupported slack action_id', { action_id: action.action_id });
    return 1;
  }
}

async function sendMessageToSlackResponseUrl(responseUrl, message) {
  console.log(JSON.stringify(message));
  return await fetch(responseUrl, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(message)
  });
}

function validateVolunteerAssigned(records, volunteerKey) {
  const mismatchedVolunteerTickets = _.filter(records, ([, fields,]) => {
    return !_.includes(fields.deliveryVolunteer, volunteerKey);
  });
  if (!_.isEmpty(mismatchedVolunteerTickets)) {
    const mismatchedTicketIDs = _.join(
      _.map(mismatchedVolunteerTickets, ([, fields,]) => {
        return fields.ticketID;
      }),
      ', '
    );
    throw new Error(`Volunteer ${volunteerKey} requested a shopping list for tickets they are not assigned to: ${mismatchedTicketIDs}`);
  }
}

function renderTicketMetadata(fields) {
  return `
**Ticket ID:** ${fields.ticketID}<br/>
**Neighbor:** ${fields.requestName} (${fields.nearestIntersection})<br/>
**Address:** ${fields.address}<br/>
**Phone:** ${fields.phoneNumber}<br/>
**Delivery Notes:** ${fields.deliveryNotes}<br/>
**Vulnerabilities:** ${fields.vulnerability}<br/>
**Household Size:** ${fields.householdSize}<br/>`;
}

async function getSingleShoppingListEmail(records, volunteer) {
  if (records.length !== 1) {
    throw new Error(`Found ${records.length} records`);
  }
  const shoppingList = await getShoppingList(records);
  const [, fields] = records[0];
  var email = `
Hi ${volunteer.Name.split(' ')[0]}!

Thank you for volunteering to deliver groceries to our neighbors with Bed-Stuy Strong!

Here's your shopping list:

${renderTicketMetadata(fields)}
${renderSingleTicketShoppingList(shoppingList)}
**Other Items:** ${fields.otherItems}
`;
  return new Email(email, {
    to: volunteer.email,
    replyTo: 'noreply@bedstuystrong.com',
    from: `shopping-lists@${emailDomain}`,
    subject: `${fields.ticketID}: Bed Stuy Strong Shopping List`,
  });
}

async function getConsolidatedShoppingListEmail(records, volunteer) {
  const shoppingList = await getShoppingList(records);

  var email = `
Hi ${volunteer.Name.split(' ')[0]}!

Thank you for volunteering to deliver groceries to our neighbors with Bed-Stuy Strong!

Here's your shopping list for all the tickets assigned to you right now. Your ticket details are at the bottom of this email.

${renderShoppingList(shoppingList)}
`;
  _.forEach(records, ([, fields,]) => {
    email += `
**Other items for ${fields.ticketID}:** ${fields.otherItems}
`;
  });
  email += '\n\n## Ticket details:\n\n';
  _.forEach(records, ([, fields,]) => {
    email += renderTicketMetadata(fields);
    email += '\n---\n';
  });

  const ticketIDs = _.join(_.map(records, ([, fields,]) => { return fields.ticketID; }), ', ');

  return new Email(email, {
    to: volunteer.email,
    replyTo: 'noreply@bedstuystrong.com',
    from: `shopping-lists@${emailDomain}`,
    subject: `${ticketIDs}: Bed Stuy Strong Shopping List`,
  });
}
