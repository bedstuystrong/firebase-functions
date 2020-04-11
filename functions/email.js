const Busboy = require('busboy');


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

const extractPaymentDetails = (platform, email) => {
  const details = {};

  switch (platform) {
  case 'venmo': {
    console.log('venmo', email.text)
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
      details.amount = toMatches[2];
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
      details.amount = toMatches[1];
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
      details.amount = toMatches[1];
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
      details.amount = toMatches[2];
    }

    break;
  }
  case 'cashapp': {
    details.platform = 'Cash App';
    const fromMatches = email.subject.match(/(?:Fwd:\s)?(.+) sent you (\$[\d\.,]+)(?: for (.*))?/);
    const toMatches = email.subject.match(/You sent (\$[\d\.,]+) to (.*)(?: for (.*))?/);
    
    if (fromMatches) {
      details.direction = 'In';
      details.name = fromMatches[1];
      details.amount = fromMatches[2];
      details.note = fromMatches[3];
    } else if (toMatches) {
      details.direction = 'Out';
      details.name = toMatches[2];
      details.amount = toMatches[1];
      details.note = fromMatches[3];
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
  extractPaymentDetails,
};