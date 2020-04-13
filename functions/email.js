/* eslint-disable no-useless-escape */
const Busboy = require('busboy');
const _ = require('lodash');

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
    return _.findKey(platforms, (platform) => {
      if (platform.from) {
        return platform.from === email.from;
      } else {
        return platform.regex.test(email.text);
      }
    });
  } else {
    return _.findKey(platforms, platform => platform.regex.test(email.text));
  }
};

const extractPaymentDetails = (platform, email) => {
  const details = {};

  switch (platform) {
  case 'venmo': {
    details.platform = 'Venmo';
    const fromMatches = email.subject.match(/(?:Fwd:\s)?(.+) paid you (\$[\d\.,]+)/);
    const toMatches = email.subject.match(/You paid (.+) (\$[\d\.,]+)/);

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
    const fromMatches = email.text.match(/tell you that (.*) sent ([\$\d\.,]+) with/);
    const toMatches = email.text.match(/that you sent (\$[\d\.,]+) to (.*) on/);

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
    const fromMatches = email.text.match(/(.*) sent you ([\$\d\.,]+)/);
    const toMatches = email.text.match(/You sent ([\$\d\.,]+) USD to (.*)/);
    const noteMatches = email.text.match(/\[image: quote\] (.*) \[image: quote\]/);

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
    const fromMatches = email.subject.match(/(.*) sent you ([\$\d\.,]+)/);
    const toMatches = email.subject.match(/You sent ([^\$]+) ([\$\d\.,]+)/);

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
    const fromMatches = email.subject.match(/(?:Fwd:\s)?(.+) sent you (\$[\d\.,]+)(?: for (.*))?/);
    const toMatches = email.subject.match(/You sent (\$[\d\.,]+) to (.*)/);
    const toAcceptedMatches = email.subject.match(/(?:Fwd: )?(.*) just accepted the (\$[\d\.,]+) you sent for (.*)/);

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
  sendgridMiddleware,
  detectPaymentPlatform,
  extractPaymentDetails,
};
