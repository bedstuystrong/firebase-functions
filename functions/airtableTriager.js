const functions = require('firebase-functions');

const Slack = require("slack")

const { getChangedIntakeTickets } = require("./airtable")

const bot = new Slack({ "token": functions.config().slack.token })

const NEIGHBORHOOD_TO_CHANNEL = {
    "NW": "northwest_bedstuy",
    "NE": "northeast_bedstuy",
    "SW": "southwest_bedstuy",
    "SE": "southeast_bedstuy",
    // "Clinton Hill / Fort Greene": "clintonhill",
    // "Crown Heights / Brownsville / Flatbush": "crownheights",
}

const CHANNEL_TO_ID = functions.config().slack.channel_to_id;

async function onNewIntake(id, fields) {
    console.log(`onNewIntake(${id})`)

    const neighborhoodChanName = NEIGHBORHOOD_TO_CHANNEL[fields["Neighborhood"]]

    // e.g. crown heights
    if (!neighborhoodChanName) {
        return
    }

    const neighborhoodChanID = CHANNEL_TO_ID[neighborhoodChanName]

    // TODO : add some better content
    const res = await bot.chat.postMessage({
        "channel": neighborhoodChanID,
        "text": `HELLO! There is a new ticket: ${fields["Ticket ID"]}`,
    })

    if (!res["ok"]) {
        console.error(`Encountered an error posting ticket to #${neighborhoodChanName}: ${id}`)
        return
    }
}

// Runs every minute
exports.poll.airtableIntakeTickets = functions.pubsub.schedule('* * * * *').onRun(async () => {
    const STATUS_TO_CBS = {
        "Seeking Volunteer": [onNewIntake],
        "Assigned / In Progress": [],
        "Complete": [],
        "Not Bed-Stuy": [],
    }

    const changedTickets = await getChangedIntakeTickets()

    if (changedTickets.length === 0) {
        return null
    }

    // TODO : it is possible for us to miss a step in the intake ticket state transitions.
    // A ticket should go from "Seeking Volunteer" -> "Assigned" -> "Complete". Since we
    // only trigger on the current state, there is a race condition where we could miss
    // the intermediate state (i.e. assigned)
    for (const [id, fields] of changedTickets) {
        console.log(`Processing intake ticket (${fields["Ticket ID"]}): ${id}`)

        const status = fields["Status"]
        if (!(status in STATUS_TO_CBS)) {
            console.error(`Ticket has invalid status: ${status}`)
            continue
        }

        for (const cb of STATUS_TO_CBS[status]) {
            // eslint-disable-next-line callback-return
            await cb(id, fields)
        }
    }

    // TODO : disable this logging later, might be useful as we get this up and running
    console.log(`All changed tickets: ${changedTickets}`)

    return null
})
