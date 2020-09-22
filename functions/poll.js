const functions = require('firebase-functions');
const Slack = require('slack');
const allSettled = require('promise.allsettled');
const _ = require('lodash');

allSettled.shim();

const {
  INBOUND_TABLE,
  INTAKE_TABLE,
  META_STORE_KEYS,
  REIMBURSEMENTS_TABLE,
  VOLUNTEER_FORM_TABLE,
  getChangedRecords,
  getMeta,
  getLastNonDuplicate,
  getRecord,
  getRecordsWithStatus,
  getTicketDueDate,
  getVolunteerSlackID,
  storeMeta,
  updateRecord,
} = require('./airtable');

const {
  INBOUND_STATUSES
} = require('./schema');

const {
  getIntakePostContent,
  getIntakePostDetails,
  getDeliveryDMContent,
  renderDeliveryDM,
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

/* GENERAL */

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


/* INBOUND */

async function onNewInbound(id, fields, ) {
  console.log('onNewInbound', { id: id, phoneNumber: fields.phoneNumber });

  const UNKNOWN_CALLER_NUMBER = '696687';

  let newStatus = null;

  if (fields.method === 'Email') {
    // TODO we could do deduping of emails as well, but its just not worth it atm
    newStatus = INBOUND_STATUSES.intakeNeeded;
  } else if (fields.phoneNumber === UNKNOWN_CALLER_NUMBER) {
    // If the caller is unknown, we always need to handle the record individually
    newStatus = INBOUND_STATUSES.intakeNeeded;
  } else {
    const lastRecord = await getLastNonDuplicate(fields.phoneNumber);

    if (_.isNull(lastRecord)) {
      console.log('Did not find a previous record');

      newStatus = INBOUND_STATUSES.intakeNeeded;
    } else {
      const [lastRecordId, lastRecordFields,] = lastRecord;
      const lastStatus = lastRecordFields.status;

      console.log('Found previous record', { id: lastRecordId, status: lastStatus });

      if (
        lastStatus === INBOUND_STATUSES.intakeNeeded ||
        lastStatus === INBOUND_STATUSES.spanishIntakeNeeded ||
        lastStatus === INBOUND_STATUSES.inProgress
      ) {
        // We haven't called them back yet
        newStatus = INBOUND_STATUSES.duplicate;
      } else if (lastStatus === INBOUND_STATUSES.intakeComplete) {
        // TODO : check the ticket for this record to see if it has been completed, if not make this 'Follow Up'
        newStatus = INBOUND_STATUSES.intakeNeeded;
      } else if (lastStatus === INBOUND_STATUSES.callBack) {
        // We are already planning on calling them back
        newStatus = INBOUND_STATUSES.duplicate;
      } else if (
        lastStatus === INBOUND_STATUSES.phoneTag || lastStatus === INBOUND_STATUSES.outOfService
      ) {
        // Mark the original ticket as call back, and mark this one a duplicate
        await updateRecord(
          INBOUND_TABLE,
          lastRecordId,
          {
            status: INBOUND_STATUSES.callBack,
          }
        );

        newStatus = INBOUND_STATUSES.duplicate;
      } else if (
        lastStatus === INBOUND_STATUSES.thankYou ||
        lastStatus === INBOUND_STATUSES.question ||
        lastStatus === INBOUND_STATUSES.noNeed
      ) {
        // This could be a new request
        newStatus = INBOUND_STATUSES.intakeNeeded;
      } else if (lastStatus === INBOUND_STATUSES.outsideBedStuy) {
        newStatus = INBOUND_STATUSES.intakeNeeded;
      } else if (lastStatus === INBOUND_STATUSES.duplicate) {
        throw Error('Should not have gotten a "duplicate" status from "getLastNonDuplicate"');
      } else {
        console.error('Encountered an invalid status', { status: lastStatus });
      }

      // Keep track of duplicate tickets in the orginal record
      if (newStatus === INBOUND_STATUSES.duplicate) {
        await updateRecord(
          INBOUND_TABLE,
          lastRecordId,
          {
            otherInbounds: _.uniq(
              _.concat(
                lastRecordFields.otherInbounds || [],
                id,
              )
            ),
          },
        );
      }
    }
  }

  if (_.isNull(newStatus)) {
    throw Error('Did not get a new status for for ticket');
  }

  console.log('Setting new status', { newStatus });

  await updateRecord(
    INBOUND_TABLE,
    id,
    {
      status: newStatus,
    },
  );

  return {};
}


/* INTAKE */

// TODO : move slack calls to own file

async function updateTicketPost(handler, fields, meta) {
  const ticketResponse = await bot.chat.update({
    channel: meta.intakePostChan,
    ts: meta.intakePostTs,
    text: await getIntakePostContent(fields),
  });

  if (ticketResponse.ok) {
    console.log(`${handler}: Slack post updated`, {
      channel: meta.intakePostChan,
      timestamp: meta.intakePostTs,
      ticket: fields.ticketID,
    });
  } else {
    console.error(`${handler}: Error updating Slack post`, {
      channel: meta.intakePostChan,
      timestamp: meta.intakePostTs,
      ticket: fields.ticketID,
      response: ticketResponse,
    });
  }
  return ticketResponse;
}

async function onIntakeReady(id, fields, meta) {
  console.log('onIntakeReady', { record: id, ticket: fields.ticketID });

  if (meta.intakePostChan || meta.intakePostTs) {
    const ticketResponse = await updateTicketPost('onIntakeReady', fields, meta);
    if (!ticketResponse.ok) {
      return null;
    }
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

  const ticketResponse = await updateTicketPost('onIntakeAssigned', fields, meta);
  if (!ticketResponse.ok) {
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

  const deliveryDMContent = await getDeliveryDMContent(fields);
  const deliveryMessageResponse = await bot.chat.postMessage(renderDeliveryDM(fields.ticketID, deliveryDMContent, deliveryChannel));

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

async function onIntakeBulkStatuses(id, fields, meta) {
  console.log('onIntakeBulkStatuses', { record: id, ticket: fields.ticketID });

  if (!meta.intakePostChan || !meta.intakePostTs) {
    console.error('onIntakeBulkStatuses: Missing Slack post for ticket', {
      ticket: fields.ticketID,
    });
    return null;
  }

  const ticketResponse = await updateTicketPost('onIntakeBulkStatuses', fields, meta);
  if (!ticketResponse.ok) {
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

  const ticketResponse = await updateTicketPost('onIntakeCompleted', fields, meta);
  if (!ticketResponse.ok) {
    return null;
  }

  return {};
}


/* VOLUNTEER */

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


/* REIMBURSEMENT */

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


/* DIGEST */

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


/* FUNCTIONS */

module.exports = {
  inbounds: functions.runWith(
    // Set to the maximum timeout and memory usage
    {
      timeoutSeconds: 90,
      memory: '1GB'
    }
  ).pubsub.schedule('every 2 minutes').onRun(async () => {
    const STATUS_TO_CALLBACKS = {
      [null]: [onNewInbound],
      [INBOUND_STATUSES.intakeNeeded]: [],
      [INBOUND_STATUSES.inProgress]: [],
      [INBOUND_STATUSES.intakeComplete]: [],
      [INBOUND_STATUSES.duplicate]: [],
      [INBOUND_STATUSES.outsideBedStuy]: [],
      [INBOUND_STATUSES.callBack]: [],
      [INBOUND_STATUSES.question]: [],
      [INBOUND_STATUSES.thankYou]: [],
      [INBOUND_STATUSES.spanishIntakeNeeded]: [],
      [INBOUND_STATUSES.noNeed]: [],
      [INBOUND_STATUSES.phoneTag]: [],
      [INBOUND_STATUSES.outOfService]: [],
    };

    return await pollTable(INBOUND_TABLE, STATUS_TO_CALLBACKS, true);
  }),
  // Runs every minute
  intakes: functions.pubsub.schedule('every 1 minutes').onRun(async () => {
    const STATUS_TO_CALLBACKS = {
      'Seeking Volunteer': [onIntakeReady],
      'Assigned / In Progress': [onIntakeAssigned],
      'Bulk Delivery Scheduled': [onIntakeBulkStatuses],
      'Bulk Delivery Confirmed': [onIntakeBulkStatuses],
      'Complete': [onIntakeCompleted],
      'Not Bed-Stuy': [],
      'Assistance No Longer Required': [],
      'Cannot Reach / Out of Service': [],
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
