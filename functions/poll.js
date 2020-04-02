const functions = require('firebase-functions');
const Slack = require('slack');
const allSettled = require('promise.allsettled');
const _ = require('lodash');

allSettled.shim();

const {
  getChangedRecords,
  updateRecord,
  getVolunteerSlackID,
  getRecordsWithTicketID,
  INTAKE_TABLE,
  REIMBURSEMENTS_TABLE
} = require('./airtable');
const { getIntakePostContent, getIntakePostDetails, getDeliveryDMContent } = require('./messages');

const bot = new Slack({ token: functions.config().slack.token });

const NEIGHBORHOOD_CHANNELS = {
  'NW': 'northwest_bedstuy',
  'NE': 'northeast_bedstuy',
  'SW': 'southwest_bedstuy',
  'SE': 'southeast_bedstuy',
  'Clinton Hill': 'clintonhill',
  'Crown Heights': 'crownheights',
  'Brownsville': 'crownheights',
};

const CHANNEL_IDS = functions.config().slack.channel_to_id;

// TODO: move slack calls to own file

async function onIntakeReady(id, fields, meta) {
  console.log('onIntakeReady', { record: id, ticket: fields.ticketID });

  // TODO : handle going back from assigned state

  if (meta.intakePostChan || meta.intakePostTs) {
    console.error('onIntakeReady: Already processed ticket', {
      ticket: fields.ticketID,
    });
    return {};
  }

  const neighborhoodChannelName = NEIGHBORHOOD_CHANNELS[fields.neighborhood];

  if (!neighborhoodChannelName) {
    console.error('onIntakeReady: Ticket in unsupported neighborhood', {
      ticket: fields.ticketID,
      neighborhood: fields.neighborhood,
    });
    return null;
  }

  const neighborhoodChannelID = CHANNEL_IDS[neighborhoodChannelName];

  const postResponse = await bot.chat.postMessage({
    channel: neighborhoodChannelID,
    text: await getIntakePostContent(fields),
    unfurl_media: false,
  });

  if (postResponse.ok) {
    console.log('onIntakeReady: Slack post created', {
      channel: neighborhoodChannelID,
      timestamp: postResponse.ts,
      ticket: fields.ticketID,
    });
  } else {
    console.error('onIntakeReady: Error posting to Slack', {
      channel: neighborhoodChannelID,
      ticket: fields.ticketID,
      response: postResponse,
    });
    return null;
  }

  const detailsResponse = await bot.chat.postMessage({
    channel: neighborhoodChannelID,
    text: await getIntakePostDetails(fields),
    thread_ts: postResponse.ts
  });

  if (detailsResponse.ok) {
    console.log('onIntakeReady: Slack details posted to thread', {
      channel: neighborhoodChannelID,
      timestamp: detailsResponse.ts,
      ticket: fields.ticketID,
    });
  } else {
    console.error('onIntakeReady: Error posting details to Slack thread', {
      channel: neighborhoodChannelID,
      ticket: fields.ticketID,
      response: detailsResponse,
    });
    return null;
  }

  // TODO : add a link the slack post
  return {
    intakePostChan: neighborhoodChannelID,
    intakePostTs: postResponse.ts
  };
}

async function onIntakeAssigned(id, fields, meta) {
  console.log('onIntakeAssigned', { record: id, ticket: fields.ticketID });

  if (!meta.intakePostChan || !meta.intakePostTs) {
    console.error('onIntakeAssigned: Missing Slack post for ticket', {
      ticket: fields.ticketID,
    });
    return null;
  }

  const ticketResponse = await bot.chat.update({
    channel: meta.intakePostChan,
    ts: meta.intakePostTs,
    text: await getIntakePostContent(fields),
  });

  if (ticketResponse.ok) {
    console.log('onIntakeAssigned: Slack post updated', {
      channel: meta.intakePostChan,
      timestamp: meta.intakePostTs,
      ticket: fields.ticketID,
    });
  } else {
    console.error('onIntakeAssigned: Error updating Slack post', {
      channel: meta.intakePostChan,
      timestamp: meta.intakePostTs,
      ticket: fields.ticketID,
      response: ticketResponse,
    });
    return null;
  }

  const deliveryChannel = await getVolunteerSlackID(fields.deliveryVolunteer);
  if (!deliveryChannel) {
    console.error('Missing Delivery Volunteer Slack ID', {
      ticket: fields.ticketID,
      volunteer: fields.deliveryVolunteer,
    });
    return null;
  }

  const deliveryMessageResponse = await bot.chat.postMessage({
    channel: deliveryChannel,
    as_user: true,
    text: await getDeliveryDMContent(fields),
    unfurl_media: false,
  });

  if (deliveryMessageResponse.ok) {
    console.log('onIntakeAssigned: Delivery DM sent', {
      channel: deliveryChannel,
      ticket: fields.ticketID,
    });
  } else {
    console.error('onIntakeAssigned: Error sending delivery DM', {
      channel: deliveryChannel,
      ticket: fields.ticketID,
      response: deliveryMessageResponse,
    });
    return null;
  }

  // TODO : post a comment in the thread saying that the delivery has been claimed
  return {
    intakePostTs: ticketResponse.ts,
  };
}

async function onIntakeCompleted(id, fields, meta) {
  console.log('onIntakeCompleted', { record: id, ticket: fields.ticketID });

  // TODO : we could try recovering from this by calling `onNewIntake` manually
  if (!meta.intakePostChan || !meta.intakePostTs) {
    console.error('onIntakeCompleted: Missing Slack post for ticket', {
      ticket: fields.ticketID,
    });
    return null;
  }

  const ticketResponse = await bot.chat.update({
    channel: meta.intakePostChan,
    ts: meta.intakePostTs,
    text: await getIntakePostContent(fields),
  });

  if (ticketResponse.ok) {
    console.log('onIntakeCompleted: Slack post updated', {
      channel: meta.intakePostChan,
      timestamp: meta.intakePostTs,
      ticket: fields.ticketID,
    });
  } else {
    console.error('onIntakeCompleted: Error updating Slack post', {
      channel: meta.intakePostChan,
      timestamp: meta.intakePostTs,
      ticket: fields.ticketID,
      response: ticketResponse,
    });
    return null;
  }

  return {};
}

async function onReimbursementCreated(id, fields) {
  console.log('onReimbursementCreated', { record: id, ticket: fields.ticketID });

  // TODO : error handling
  const intakeRecords = await getRecordsWithTicketID(INTAKE_TABLE, fields.ticketID);

  if (intakeRecords.length > 1) {
    console.error('onReimbursementCreated: Multiple intake records exist for ticket', {
      record: id,
      ticket: fields.ticketID,
    });
  } else if (intakeRecords.length === 0) {
    console.error('onReimbursementCreated: No intake records exist for ticket', {
      record: id,
      ticket: fields.ticketID,
    });
  } else {
    // Close the intake ticket
    // NOTE that this will trigger the intake ticket on complete function
    const [intakeID, , intakeMeta] = intakeRecords[0];
    await updateRecord(INTAKE_TABLE, intakeID, { status: 'Complete' }, intakeMeta);

    console.log('onReimbursementCreated: Completed intake ticket', {
      ticket: fields.ticketID,
    });
  }

  // TODO: send reimbursement message

  return {};
}

// Processes all tickets in a table that have a new status
async function pollTable(table, statusToCallbacks) {
  const changedTickets = await getChangedRecords(table);

  if (changedTickets.length === 0) {
    return Promise.resolve();
  }

  // TODO : it is possible for us to miss a step in the intake ticket state transitions.
  // For example, an intake ticket should go from "Seeking Volunteer" -> "Assigned" -> 
  // "Complete". Since we only trigger on the current state, there is a race condition 
  // where we could miss the intermediate state (i.e. assigned).
  //
  // NOTE that the `meta` object is passed to all callbacks, which can make modifications to it.
  const updates = changedTickets.map(async ([id, fields, meta]) => {
    // NOTE that this is a mechanism to easily allow us to ignore tickets in airtable
    if (meta.ignore) {
      return null;
    }

    const status = fields.status;
    if (!(status in statusToCallbacks)) {
      throw new Error(`Record ${id} has unsupported status: ${status}`);
    }

    const results = await Promise.allSettled(
      statusToCallbacks[status].map(async (action) => {
        return await action(id, fields, meta);
      })
    );

    if (_.some(results, ['status', 'rejected'])) {
      console.error('Actions failed for ticket', {
        ticket: fields.ticketID,
        reasons: _.map(_.filter(results, ['status', 'rejected']), 'reason'),
      });
      return null;
    }

    // Once we have processed all callbacks for a ticket, note that we have seen it,
    // and update its meta field
    const updatedMeta = _.assign(meta, _.reduce(_.map(results, 'value'), _.assign));
    updatedMeta.lastSeenStatus = fields.status || null;
    console.log('updatedMeta', updatedMeta);
    return await updateRecord(table, id, {}, updatedMeta);
  });

  return await Promise.allSettled(updates);
}

module.exports = {
  // Runs every minute
  intakes: functions.pubsub.schedule('every 1 minutes').onRun(async () => {
    const STATUS_TO_CALLBACKS = {
      'Seeking Volunteer': [onIntakeReady],
      'Assigned / In Progress': [onIntakeAssigned],
      'Complete': [onIntakeCompleted],
      'Not Bed-Stuy': [],
    };

    return await pollTable(INTAKE_TABLE, STATUS_TO_CALLBACKS);
  }),
  reimbursements: functions.pubsub.schedule('every 1 minutes').onRun(async () => {
    const STATUS_TO_CALLBACKS = {
      'New': [onReimbursementCreated],
      'In Progress': [],
      'Complete': [],
    };

    return await pollTable(REIMBURSEMENTS_TABLE, STATUS_TO_CALLBACKS);
  }),
};
