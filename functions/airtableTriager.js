const functions = require('firebase-functions');

const { getChangedIntakeTickets } = require('./airtable');

// Runs every minute
exports.poll = functions.pubsub.schedule('* * * * *').onRun(async () => {
    const changedTickets = await getChangedIntakeTickets()

    if (changedTickets.length === 0) {
        return null
    }

    console.log(changedTickets)

    return null
})
