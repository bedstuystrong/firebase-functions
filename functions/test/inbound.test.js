const test = require('firebase-functions-test')();
const assert = require('assert');
const sinon = require('sinon');
const Airtable = require('airtable');

test.mockConfig({
  environment: {
    type: 'test',
  },
  airtable: {
    api_key: 'placeholder',
    inbound_table: '_test_inbound',
    base_id: '',
  }
});

describe('test inbound functions', () => {
  const sandbox = sinon.createSandbox();
  const twilio = require('../twilio');
  let airtableSpy;

  beforeEach(() => {
    airtableSpy = sandbox.spy(Airtable);
    sandbox.replace(twilio, 'middleware', (_req, _res, next) => next());
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('can receive a text message', async () => {
    const inbound = require('../inbound');
    const req = {
      body: {
        From: '+5555555555',
      },
    };
    const res = {};
    await inbound.sms(req, res);
    console.log(airtableSpy)
  });
});