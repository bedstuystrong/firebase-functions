# automation firebase project

`firebase emulators:start`

to deploy one set of functions:
`firebase deploy --only functions:[namespace]`

to deploy just the website:
`firebase deploy --only hosting`

## config

https://firebase.google.com/docs/functions/config-env

config structure
```json
{
  "airtable": {
    "api_key": "",
    "base_id": "",
    "inbound_table": "",
    "intake_table": "",
    "reimbursements_table": "",
    "volunteers_table": ""
  },
  "twilio": {
    "auth_token": "",
    "sid": ""
  },
  "slack": {
    "token": "",
    "channel_to_id": {}
  }
}
```

## polling functions

to test scheduled functions, add the following to `functions/index.js` and hit endpoint to trigger functions

```js
const functions = require('firebase-functions');
const { PubSub } = require('@google-cloud/pubsub');
exports.test = functions.https.onRequest(async (_req, res) => {
  const pubsub = new PubSub();
  const pubsubPrefix = 'firebase-schedule-poll-';

  await pubsub.topic(`${pubsubPrefix}intakes`).publishJSON({});
  await pubsub.topic(`${pubsubPrefix}reimbursements`).publishJSON({});

  res.json({ cool: true });
});
```

## inbound functions

https://firebase.google.com/docs/functions/http-events#use_middleware_modules_with