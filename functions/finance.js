
const functions = require('firebase-functions');
const { simpleParser } = require('mailparser');
const sendgridMail = require('@sendgrid/mail');
const Busboy = require('busboy');
const pick = require('lodash/pick');
const findKey = require('lodash/findKey');
const { flow, get, map, first } = require('lodash/fp');

const { createFinanceTransaction } = require('./airtable');

sendgridMail.setApiKey(functions.config().sendgrid.api_key);

const sendgridMiddleware = (req, res, next) => {
  const busboy = new Busboy({ headers: req.headers });

  busboy.on('field', (fieldname, value) => {
    req.body[fieldname] = value;
  });

  busboy.on('finish', () => {
    next();
  });

  busboy.end(req.rawBody);
};

const platforms = {
  venmo: {
    from: 'venmo@venmo.com',
    regex: /From: Venmo <venmo@venmo\.com>/,
  },
  zelle: {
    from: '',
    regex: /USAA Confirmation ID: [\d\n\r]+Zelle ID:/m,
  },
  paypal: {
    from: 'service@paypal.com',
    regex: /From: service@paypal\.com <service@paypal\.com>/,
  },
  googlepay: {
    from: 'googlepay-noreply@google.com',
    regex: /From: Google Pay <googlepay-noreply@google\.com>/,
  },
  cashapp: {
    from: 'cash@square.com',
    regex: /From: Cash App <cash@square\.com>/
  },
};

const detectPaymentPlatform = (email, { isAutoForwarded }) => {
  if (isAutoForwarded) {
    return findKey(platforms, (platform) => {
      if (platform.from) {
        return platform.from === email.from;
      } else {
        return platform.regex.test(email.text);
      }
    });
  } else {
    return findKey(platforms, platform => platform.regex.test(email.text));
  }
};

const extractPaymentDetails = (platform, email) => {
  const details = {};

  switch (platform) {
  case 'venmo': {
    details.platform = 'Venmo';
    const fromMatches = email.subject.match(/(?:Fwd:\s)?(.+) paid you (\$[\d.,]+)/);
    const toMatches = email.subject.match(/You paid (.+) (\$[\d.,]+)/);

    if (fromMatches) {
      details.direction = 'In';
      details.name = fromMatches[1];
      details.amount = fromMatches[2];
    } else if (toMatches) {
      details.direction = 'Out';
      details.name = toMatches[1];
      details.amount = '-' + toMatches[2];
    }
    break;
  }
  case 'zelle': {
    details.platform = 'Zelle';
    const fromMatches = email.text.match(/tell you that (.*) sent ([$\d.,]+) with/);
    const toMatches = email.text.match(/that you sent (\$[\d.,]+) to (.*) on/);

    if (fromMatches) {
      details.direction = 'In';
      details.name = fromMatches[1];
      details.amount = fromMatches[2];
    } else if (toMatches) {
      details.direction = 'Out';
      details.name = toMatches[2];
      details.amount = '-' + toMatches[1];
    }
    break;
  }
  case 'paypal': {
    details.platform = 'Paypal';
    const text = email.html.replace(/(<([^>]+)>)/ig, '');
    console.log('paypal text', text)
    const fromMatches = text.match(/(.*) sent you ([$\d.,]+)/);
    const toMatches = text.match(/You sent ([$\d.,]+) USD to (.*)/);
    const noteMatches = text.match(/\[image: quote\] (.*) \[image: quote\]/);

    if (fromMatches) {
      details.direction = 'In';
      details.name = fromMatches[1];
      details.amount = fromMatches[2];
    } else if (toMatches) {
      details.direction = 'Out';
      details.name = toMatches[2];
      details.amount = '-' + toMatches[1];
    }

    if (noteMatches) {
      details.note = noteMatches[1];
    }

    break;
  }
  case 'googlepay': {
    details.platform = 'Google Pay';
    const fromMatches = email.subject.match(/(.*) sent you ([$\d.,]+)/);
    const toMatches = email.subject.match(/You sent ([^$]+) ([$\d.,]+)/);

    if (fromMatches) {
      details.direction = 'In';
      details.name = fromMatches[1];
      details.amount = fromMatches[2];
    } else if (toMatches) {
      details.direction = 'Out';
      details.name = toMatches[1];
      details.amount = '-' + toMatches[2];
    }

    break;
  }
  case 'cashapp': {
    details.platform = 'Cash App';
    const fromMatches = email.subject.match(/(?:Fwd:\s)?(.+) sent you (\$[\d.,]+)(?: for (.*))?/);
    const toMatches = email.subject.match(/You sent (\$[\d.,]+) to (.*)/);
    const toAcceptedMatches = email.subject.match(/(?:Fwd: )?(.*) just accepted the (\$[\d.,]+) you sent for (.*)/);

    if (fromMatches) {
      details.direction = 'In';
      details.name = fromMatches[1];
      details.amount = fromMatches[2];
      details.note = fromMatches[3];
    } else if (toMatches) {
      details.direction = 'Out';
      details.amount = '-' + toMatches[1];

      const split = toMatches[2].split(/ for (.+)/);
      if (split.length > 1) {
        details.name = split[0];
        details.note = split[1];
      } else {
        details.name = split[0];
      }
    } else if (toAcceptedMatches) {
      details.direction = 'Out';
      details.name = toAcceptedMatches[1];
      details.amount = '-' + toAcceptedMatches[2];
      details.note = toAcceptedMatches[3];
    }

    break;
  }
  default:
    throw new Error(`Unhandled payment platform: ${platform}`);
  }

  return details;
};

module.exports = {
  email: functions.https.onRequest((req, res) => {
    return sendgridMiddleware(req, res, async () => {
      const email = pick(req.body, ['to', 'from', 'headers', 'subject', 'text', 'html']);
      const parsed = await simpleParser(email.headers);
      const date = parsed.headers.get('date');
      email.to = flow(
        get('value'),
        map(v => v.address),
        first,
      )(parsed.headers.get('to'));

      if (email.to.split('@')[0] !== 'funds' && email.to !== 'fund@bedstuystrong.com') {
        // Log and do nothing
        console.warn('Received email for user other than funds@', email);
        return res.status(200).send('OK');
      }

      const IS_AUTO_FORWARDED = email.to === 'fund@bedstuystrong.com';

      email.from = flow(
        get('value'),
        map(v => v.address),
        first,
      )(parsed.headers.get('from'));
      const fromKey = email.from.replace(/[@.]/g, '_');
      const accountHolder = functions.config().finance.emails[fromKey];

      if (!IS_AUTO_FORWARDED && !Object.keys(functions.config().finance.emails).includes(fromKey)) {
        // Log and do nothing
        console.warn('Received email from unauthorized forwarder', email);
        return res.status(200).send('OK');
      }
      
      const paymentPlatform = detectPaymentPlatform(email, { isAutoForwarded: IS_AUTO_FORWARDED });
      if (!paymentPlatform) {
        // todo error
        console.error(email);
        await sendgridMail.send({
          from: 'finance-script@em9481.mail.bedstuystrong.com',
          to: 'fund@bedstuystrong.com',
          subject: 'Error parsing payment email',
          text: `Timestamp: ${(new Date()).toString()}`
        });
        throw new Error('Couldn\'t detect payment platform');
      }

      const details = extractPaymentDetails(paymentPlatform, email);

      await createFinanceTransaction(Object.assign(details, { date, accountHolder }));

      return res.status(200).send('OK');
    });
  }),
};