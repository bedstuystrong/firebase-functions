# bss-firebase

## Introduction

This repo name is a misnomer! What we actually have is a -- er -- _monorepo_ composed of two distinct deployments:

- [www.bedstuystrong.com](https://bedstuystrong.com/) (`./public/*`)
- *Cloud Functions for Slack* (`./functions/*`)

## Prerequisites

- airtable access
- firebase access (prod and test)
- github org membership
- join #tickets (for test functions slack app)
- join #automation (for... this)

## Installation

1. Fork repo.
1. `git clone git@github.com:[your user/org name here i guess]/firebase-functions.git`
1. `cd functions && npm i`

## Configuration

- Review the [firebase docs here](https://firebase.google.com/docs/functions/config-env).
- See `./config-sample.json`

## Testing

```sh
% npm run firebase:test
% npm run deploy
```

### polling functions

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

### inbound functions

twilio is weird and makes voicemails into something that requires 3 separate requests https://www.twilio.com/docs/voice/twiml/record (we can replace at least 1 with a static url)

https://firebase.google.com/docs/functions/http-events#use_middleware_modules_with

## Deployment

to deploy one set of functions:
`firebase deploy --only functions:[namespace]`

to deploy just the website:
`firebase deploy --only hosting`

