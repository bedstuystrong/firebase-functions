
const functions = require('firebase-functions');


const { sendgridMiddleware } = require('./email');

module.exports = {
  email: functions.https.onRequest((req, res) => {
    return sendgridMiddleware(req, res, () => {
      const { from, to, headers, subject, html } = req.body;
      if (!(
        from.includes('ghostbaldwin@gmail.com') || 
        from.includes('fund@bedstuystrong.com')
      )) {
        // Do nothing
        return res.status(200).send('OK');
      }

      const useResult = ({ platform, direction, name, amount }) => {
        console.log({platform, direction, name, amount});
      };
      /* 
        TODO parse things
        have a parser(subject, html) for each service
      */
      const toPrefix = to.replace(/@.+$/m, '');
      switch (toPrefix) {
      case 'funds+venmo': {
        const fromMatches = subject.match(/(?:fwd:\s)?(.+) paid you (\$[\d\.,]+)/i);
        const toMatches = subject.match(/You paid (.+) (\$[\d\.,]+)/i);

        if (fromMatches) {
          useResult({
            platform: 'Venmo',
            direction: 'In',
            name: fromMatches[1],
            amount: fromMatches[2]
          });
        } else if (toMatches) {
          useResult({
            platform: 'Venmo',
            direction: 'Out',
            name: toMatches[1],
            amount: toMatches[2]
          });
        }
        break;
      }
      }
      return res.status(200).send('OK');
    });
  }),
};