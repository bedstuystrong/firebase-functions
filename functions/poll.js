const functions = require('firebase-functions');
const Slack = require('slack');
const allSettled = require('promise.allsettled');
const _ = require('lodash');

allSettled.shim();

const {
  INTAKE_TABLE,
  META_STORE_KEYS,
  REIMBURSEMENTS_TABLE,
  VOLUNTEER_FORM_TABLE,
  getChangedRecords,
  getMeta,
  getRecord,
  getRecordsWithStatus,
  getTicketDueDate,
  getVolunteerSlackID,
  storeMeta,
  updateRecord,
} = require('./airtable');

const {
  getIntakePostContent,
  getIntakePostDetails,
  getDeliveryDMContent,
  getTicketSummaryBlocks,
} = require('./messages');

const {
  regenerateAllTables
} = require('./bigquery');

const bot = new Slack({ token: functions.config().slack.token });

const NEIGHBORHOOD_CHANNELS = {
  NW: 'northwest_bedstuy',
  NE: 'northeast_bedstuy',
  SW: 'southwest_bedstuy',
  SE: 'southeast_bedstuy',
};

const CHANNEL_IDS = functions.config().slack.channel_to_id;

// TODO : move slack calls to own file

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

  // Do the main post
  const postResponse = await bot.chat.postMessage({
    channel: CHANNEL_IDS.tickets,
    text: await getIntakePostContent(fields),
    unfurl_media: false,
    unfurl_links: false,
  });

  if (postResponse.ok) {
    console.log('onIntakeReady: Slack post created', {
      channel: CHANNEL_IDS.tickets,
      timestamp: postResponse.ts,
      ticket: fields.ticketID,
    });
  } else {
    console.error('onIntakeReady: Error posting to Slack', {
      channel: CHANNEL_IDS.tickets,
      ticket: fields.ticketID,
      response: postResponse,
    });
    return null;
  }

  // Add a post to the thread with details
  const detailsResponse = await bot.chat.postMessage({
    channel: CHANNEL_IDS.tickets,
    text: await getIntakePostDetails(fields),
    thread_ts: postResponse.ts
  });

  if (detailsResponse.ok) {
    console.log('onIntakeReady: Slack details posted to thread', {
      channel: CHANNEL_IDS.tickets,
      timestamp: detailsResponse.ts,
      ticket: fields.ticketID,
    });
  } else {
    console.error('onIntakeReady: Error posting details to Slack thread', {
      channel: CHANNEL_IDS.tickets,
      ticket: fields.ticketID,
      response: detailsResponse,
    });
    return null;
  }

  // Get a link to the post
  const postLinkResponse = await bot.chat.getPermalink({
    channel: CHANNEL_IDS.tickets,
    message_ts: postResponse.ts
  });

  if (postLinkResponse.ok) {
    console.log('onIntakeReady: Populated slack post link', {
      ticket: fields.ticketID,
      channel: CHANNEL_IDS.tickets,
      link: postLinkResponse.permalink
    });

    console.log('onReimbursementCreated: Completed intake ticket', {
      ticket: fields.ticketID,
    });
  } else {
    console.error('onIntakeReady: Error getting link to slack post', {
      channel: CHANNEL_IDS.tickets,
      ticket: fields.ticketID,
      response: postLinkResponse,
    });
    return null;
  }

  // Get a link to the details post
  const detailsLinkResponse = await bot.chat.getPermalink({
    channel: CHANNEL_IDS.tickets,
    message_ts: detailsResponse.ts,
  });

  if (detailsLinkResponse.ok) {
    console.log('onIntakeReady: Populated slack details link', {
      ticket: fields.ticketID,
      channel: CHANNEL_IDS.tickets,
      link: detailsLinkResponse.permalink
    });
  } else {
    console.error('onIntakeReady: Error getting link to slack details', {
      channel: CHANNEL_IDS.tickets,
      ticket: fields.ticketID,
      response: detailsLinkResponse,
    });
    return null;
  }

  // Populate the slack link in the record
  // NOTE that these are the fields from the updated record
  await updateRecord(
    INTAKE_TABLE,
    id,
    {
      slackPostLink: postLinkResponse.permalink,
      slackPostThreadLink: detailsLinkResponse.permalink,
      dueDate: getTicketDueDate(fields).toISOString(),
    },
  );

  // TODO : the post to #delivery_volunteers if it is urgent

  return {
    intakePostChan: CHANNEL_IDS.tickets,
    intakePostTs: postResponse.ts,
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
    unfurl_links: false,
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

async function onNewVolunteer(id, fields) {
  console.log('onNewVolunteer', { id: id, email: fields.email });

  let res;
  try {
    res = await bot.users.lookupByEmail({ email: fields.email });
  } catch (exception) {
    // TODO FOR #23 MESSAGE A SLACK GROUP WITH ERROR
    console.error(`checkVolunteers: Error looking up volunteer by email: ${fields.email}`, exception);
    return null;
  }

  const username = res.user.profile.display_name || res.user.profile.real_name;
  if (!username || username === '') {
    console.error(`Didn't get a valid username for: ${fields.email}`, { res: res });
    return null;
  }

  await updateRecord(
    VOLUNTEER_FORM_TABLE,
    id,
    {
      slackUserID: res.user.id,
      slackEmail: res.user.profile.email,
      slackHandleDerived: `@${username}`,
    },
  );

  return {};
}

async function onNewReimbursement(id, fields) {
  console.log('onReimbursementCreated', { record: id, ticket: fields.ticketID, ticketRecords: fields.ticketRecords });

  let intakeTicketIDs = [];

  for (const recordID of fields.ticketRecords) {
    const [intakeID, intakeFields, intakeMeta] = await getRecord(INTAKE_TABLE, recordID);

    // Close the intake ticket
    // NOTE that this will trigger the intake ticket on complete function
    await updateRecord(INTAKE_TABLE, intakeID, { status: 'Complete' }, intakeMeta);

    console.log('onReimbursementCreated: Completed intake ticket', {
      ticket: intakeFields.ticketID,
    });

    intakeTicketIDs.push(intakeFields.ticketID);
  }

  // NOTE that we update the record to `New` that we have processed it
  // TODO : get rid of `ticketID`
  await updateRecord(REIMBURSEMENTS_TABLE, id, { ticketID: _.join(intakeTicketIDs), status: 'New' });

  // TODO: send reimbursement message

  return {};
}

async function sendDigest() {
  const unassignedTickets = _.filter(
    await getRecordsWithStatus(INTAKE_TABLE, 'Seeking Volunteer'),
    ([, , meta]) => !meta.ignore,
  );

  const chan = CHANNEL_IDS.delivery_volunteers;

  const postResponse = await bot.chat.postMessage({
    channel: chan,
    text: '*Delivery Request Summary*',
    blocks: await getTicketSummaryBlocks(unassignedTickets),
  });

  if (postResponse.ok) {
    console.log('sendDigest: Sent daily digest', {
      channel: chan,
      timestamp: postResponse.ts,
    });
  } else {
    console.error('sendDigest: Failed to send daily digest', {
      channel: chan,
      response: postResponse,
    });
    return null;
  }

  const digestPostInfo = await getMeta(META_STORE_KEYS.digestPostInfo);

  try {
    // Delete the last digest post
    await bot.chat.delete({
      channel: chan,
      ts: digestPostInfo.ts,
    });

    console.log('sendDigest: Deleted old digest post', {
      channel: chan,
      timestamp: postResponse.ts,
    });
  } catch (e) {
    console.error(`Failed to delete stale digest post: ${e}`, {
      channel: chan,
      ts: digestPostInfo.ts,
    });
  }

  await storeMeta(META_STORE_KEYS.digestPostInfo, { chan: chan, ts: postResponse.ts });

  return null;
}

async function updateDigest() {
  const digestPostInfo = await getMeta(META_STORE_KEYS.digestPostInfo);

  const unassignedTickets = _.filter(
    await getRecordsWithStatus(INTAKE_TABLE, 'Seeking Volunteer'),
    ([, , meta]) => !meta.ignore,
  );

  const updateResponse = await bot.chat.update({
    channel: digestPostInfo.chan,
    ts: digestPostInfo.ts,
    text: '*Delivery Request Summary*',
    blocks: await getTicketSummaryBlocks(unassignedTickets),
  });

  if (updateResponse.ok) {
    console.log('updateDigest: Updated daily digest', {
      channel: digestPostInfo.chan,
      timestamp: updateResponse.ts,
    });
  } else {
    console.error('updateDigest: Failed to update daily digest', {
      channel: digestPostInfo.chan,
      response: updateResponse,
    });
    return null;
  }

  await storeMeta(META_STORE_KEYS.digestPostInfo, { chan: digestPostInfo.chan, ts: updateResponse.ts });

  return null;
}

// Processes all records in a table that have a new status
async function pollTable(table, statusToCallbacks, includeNullStatus = false) {
  const changedRecords = await getChangedRecords(table, includeNullStatus);

  if (changedRecords.length === 0) {
    return Promise.resolve();
  }

  // TODO : it is possible for us to miss a step in the state transitions.
  // For example, an intake ticket should go from 'Seeking Volunteer' -> 'Assigned' -> 
  // 'Complete'. Since we only trigger on the current state, there is a race condition 
  // where we could miss the intermediate state (i.e. assigned).
  //
  // NOTE that the `meta` object is passed to all callbacks, which can make modifications to it.
  const updates = changedRecords.map(async ([id, fields, meta]) => {
    // NOTE that this is a mechanism to easily allow us to ignore records in airtable
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
      console.error('Actions failed for record', {
        record: id,
        reasons: _.map(_.filter(results, ['status', 'rejected']), 'reason'),
      });
      return null;
    }

    // Once we have processed all callbacks for a ticket, note that we have seen it,
    // and update its meta field
    const updatedMeta = _.assign(meta, _.reduce(_.map(results, 'value'), _.assign));
    updatedMeta.lastSeenStatus = fields.status || null;

    console.log('updatedMeta', updatedMeta);
    await updateRecord(table, id, {}, updatedMeta);
    return null;
  });

  return await Promise.all(updates);
}

module.exports = {
  // Runs every minute
  intakes: functions.pubsub.schedule('every 1 minutes').onRun(async () => {
    const STATUS_TO_CALLBACKS = {
      'Seeking Volunteer': [onIntakeReady],
      'Assigned / In Progress': [onIntakeAssigned],
      'Complete': [onIntakeCompleted],
      'Not Bed-Stuy': [],
      'Assistance no longer required': [],
    };

    return await pollTable(INTAKE_TABLE, STATUS_TO_CALLBACKS);
  }),
  reimbursements: functions.pubsub.schedule('every 1 minutes').onRun(async () => {
    const STATUS_TO_CALLBACKS = {
      [null]: [onNewReimbursement],
      'New': [],
      'In Progress': [],
      'Complete': [],
    };

    return await pollTable(REIMBURSEMENTS_TABLE, STATUS_TO_CALLBACKS, true);
  }),
  // TODO
  // volunteers: functions.pubsub.schedule('every 5 minutes').onRun(async () => {
  volunteers: functions.pubsub.schedule('* * * * *').onRun(async () => {
    const STATUS_TO_CALLBACKS = {
      [null]: [onNewVolunteer],
      // TODO : figure out if we need to do anything in the `Processed` state
      // eslint-disable-next-line quote-props
      'Processed': [],
    };

    return await pollTable(VOLUNTEER_FORM_TABLE, STATUS_TO_CALLBACKS, true);
  }),
  // Scheduled for 7am and 5pm
  sendDigest: functions.pubsub.schedule('0 7,12,17 * * *').timeZone('America/New_York').onRun(async () => {
    try {
      await sendDigest();
      console.log('sendDigest: successfully sent digest');
    } catch (exception) {
      console.error('sendDigest: encountered an error sending digest', exception);
    }
    return null;
  }),
  // Runs every five minutes, except for the first five minutes of every hour. This is a 
  // precaution against racing `sendDigest`.
  updateDigest: functions.pubsub.schedule('5-59/5 * * * *').onRun(async () => {
    try {
      await updateDigest();
      console.log('updateDigest: successfully updated digest');
    } catch (exception) {
      console.error('updateDigest: encountered an error updating digest', exception);
    }
    return null;
  }),
  // Regenerates the bigquery tables every hour
  dumpToBigQuery: functions.runWith(
    // Set to the maximum timeout and memory usage
    {
      timeoutSeconds: 120,
      memory: '1GB'
    }
  ).pubsub.schedule('0 * * * *').timeZone('America/New_York').onRun(async () => {
    console.log('Regenerating bigquery tables...');
    await regenerateAllTables();
  }),
};
