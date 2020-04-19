const functions = require('firebase-functions');

const Slack = require('slack');

const CHANNEL_IDS = functions.config().slack.channel_to_id;

const bot = new Slack({ token: functions.config().slack.token });

module.exports = {
  main: functions.https.onRequest(async (req, res) => {
    console.log('Handling slack event', { type: req.body.type });

    if (req.body.type === 'url_verification') {
      res.send(req.body.challenge);
    } else if (req.body.type === 'event_callback') {
      await triageEvent(req.body.event);
    } else {
      console.error('Encountered an unsupported request type', { type: req.body.type });
    }

    res.sendStatus(200);
  }),
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
