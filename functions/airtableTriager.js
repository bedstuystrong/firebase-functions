const functions = require('firebase-functions');

const Slack = require("slack")

const {
    getChangedRecords,
    updateRecord,
    getVolunteerSlackID,
    getRecordsWithTicketID,
    INTAKE_TABLE,
    REIMBURSEMENTS_TABLE
} = require("./airtable")

const bot = new Slack({ "token": functions.config().slack.token })

const NEIGHBORHOOD_TO_CHANNEL = {
    "NW": "northwest_bedstuy",
    "NE": "northeast_bedstuy",
    "SW": "southwest_bedstuy",
    "SE": "southeast_bedstuy",
    // "Clinton Hill / Fort Greene": "clintonhill",
    // "Crown Heights / Brownsville / Flatbush": "crownheights",
}

const STATUS_TO_EMOJI = {
    "Seeking Volunteer": ":exclamation:",
    "Assigned / In Progress": ":woman-biking:",
    "Complete": ":white_check_mark:",
}

const CHANNEL_TO_ID = functions.config().slack.channel_to_id;

// TODO : add household size
async function getIntakePostContent(fields) {
    const intakeVolunteerslackID = await getVolunteerSlackID(fields["Intake Volunteer - This is you!"])

    // TODO : error handling if volunteer id isn't present

    let content = `<!here> <@${intakeVolunteerslackID}> got a new volunteer request from our neighbor ${fields["Requestor First Name and Last Initial"]}

*Status:* ${STATUS_TO_EMOJI[fields["Status"]]} -> ${fields["Status"]}\n\n`

    if (fields["Status"] !== "Seeking Volunteer") {
        // TODO : make sure this is filled out
        const deliveryVolunteerslackID = await getVolunteerSlackID(fields["Delivery Volunteer"])
        content += `*Assigned to*: <@${deliveryVolunteerslackID}>\n\n`
    }

    content += `*Ticket ID*: ${fields["Ticket ID"]}
*Timeline*: ${fields["Need immediacy"]}
*Need*: ${fields["Need Category"]}
*Cross Streets*: ${fields["Cross Streets"]}
*Description*: ${fields["Task Overview - Posts in Slack"]}
*Language*: ${fields["Language"]}
*Requested*: ${fields["Items / Services Requested - Posts in Slack"]}

*Want to volunteer to help ${fields["Requestor First Name and Last Initial"]}?* Comment on this thread and our Intake Volunteer <@${intakeVolunteerslackID}> will follow up with more details.

_Reminder: Please don't volunteer for delivery if you have any COVID-19/cold/flu-like symptoms, or have come into contact with someone that's tested positive._

:heart: Thanks for helping keep Bed-Stuy Strong! :muscle:`

    return content
}

async function getDeliveryDMContents(fields) {
    const intakeVolunteerslackID = await getVolunteerSlackID(fields["Intake Volunteer - This is you!"])

    // TODO : gear the reimbursement flow towards delivery completion
    // TODO : error handling if volunteer id isn't present
    // TODO : don't send the volunteer this monstrosity of a message every time they take a delivery
    // TODO : template for household size info
    /*
    Household size: < household size >
    ...
    Spending guidance:
    
    [if household size = 1 or 2 ppl] "$75/per person (1-2 ppl)"
    [if household size = 3-5 ppl] "$250 for a medium household (3-5 ppl)"
    [if household size = 6+ ppl] "$350 for a large household (6+ ppl)"

    See: https://github.com/bedstuystrong/firebase-functions/issues/4#issuecomment-605095340
    */
    return `<@${intakeVolunteerslackID}> assigned a request to you. Thanks so much for taking care of this delivery!

*Ticket ID*: ${fields["Ticket ID"]}

*Neighbor*: ${fields["Requestor First Name and Last Initial"]}
*Address*: ${fields["Address (won't post in Slack)"]}
*Phone*: ${fields["Phone Number"]}
*Timeline*: ${fields["Need immediacy"]}
*Language*: ${fields["Language"]}
*FYI Special Conditions: ${fields["Vulnerability"]}

*Need*: ${fields["Need Category"]}
*Description*: ${fields["Task Overview - Posts in Slack"]}
*Requested*: ${fields["Items / Services Requested - Posts in Slack"]}

Please try to buy about a week's worth of food for the household. It's ok if you can’t get every single thing on the shopping list--the main goal is that the family’s nutritional needs are sufficiently met.

When you complete the delivery, please:
- Take a photo of the receipt (if you paid for the items)
- Fill out <https://airtable.com/shrvHf4k5lRo0I8F4|this delivery completion form>, and you will be reimbursed from our community fund within 24 hours.
- For guidance on how to do a no-contact delivery, check out our <https://docs.google.com/document/d/1-sXwubRG3yBw2URDYcrSGZSj94tY_Ydk4xxVDmgRFh8/edit?usp=sharing|Delivery Volunteer FAQ guide>.

If you have any questions/problems, please post in <#${CHANNEL_TO_ID["delivery_volunteers"]}>. Thanks again for volunteering!

_Reminder: Please don't volunteer for delivery if you have any COVID-19/cold/flu-like symptoms, or have come into contact with someone that's tested positive._

:heart: :heart: :heart:`
}

async function onNewIntake(id, fields, meta) {
    console.log(`onNewIntake(${id})`)

    // TODO : handle going back from assigned state

    if (meta["intakePostChan"] || meta["intakePostTs"]) {
        console.error(`Already processed ticket: ${id}`)
        return
    }

    const neighborhoodChanName = NEIGHBORHOOD_TO_CHANNEL[fields["Neighborhood"]]

    // e.g. crown heights
    if (!neighborhoodChanName) {
        return
    }

    const neighborhoodChanID = CHANNEL_TO_ID[neighborhoodChanName]

    const res = await bot.chat.postMessage({
        "channel": neighborhoodChanID,
        "text": await getIntakePostContent(fields),
        unfurl_media: false,
    })

    // TODO : we should retry as we might be getting throttled
    if (!res["ok"]) {
        console.error(`Encountered an error posting ticket ${id} to #${neighborhoodChanName}: ${res["error"]}`)
        return
    }

    // TODO : add a link the slack post
    meta["intakePostChan"] = neighborhoodChanID
    meta["intakePostTs"] = res["ts"]
}

async function onIntakeAssigned(id, fields, meta) {
    console.log(`onIntakeAssigned(${id})`)

    if (!meta["intakePostChan"] || !meta["intakePostTs"]) {
        console.error(`This ticket wasn't posted to slack: ${id}`)
        return
    }

    let res = await bot.chat.update({
        channel: meta["intakePostChan"],
        ts: meta["intakePostTs"],
        text: await getIntakePostContent(fields),
    })

    // TODO : we should retry as we might be getting throttled
    if (!res["ok"]) {
        console.error(`Encountered an error updating ticket ${id}: ${res["error"]}`)
        return
    }

    meta["intakePostTs"] = res["ts"]

    // TODO : use the delivery volunteer's id
    res = await bot.chat.postMessage({
        channel: "UV5KXJYTC",
        as_user: true,
        text: await getDeliveryDMContents(fields),
        unfurl_media: false,
    })

    if (!res["ok"]) {
        console.error(`Encountered an error sending dm for ticket ${id}: ${res["error"]}`)
        return
    }

    // TODO : post a comment in the thread saying that the delivery has been claimed
}

async function onIntakeCompleted(id, fields, meta) {
    console.log(`onIntakeCompleted(${id})`)

    // TODO : we could try recovering from this by calling `onNewIntake` manually
    if (!meta["intakePostChan"] || !meta["intakePostTs"]) {
        console.error(`This ticket wasn't posted to slack: ${id}`)
        return
    }

    let res = await bot.chat.update({
        channel: meta["intakePostChan"],
        ts: meta["intakePostTs"],
        text: await getIntakePostContent(fields),
    })

    // TODO : we should retry as we might be getting throttled
    if (!res["ok"]) {
        console.error(`Encountered an error updating ticket ${id}: ${res["error"]}`)
        return
    }
}

async function onReimbursementNew(id, fields) {
    console.log(`onReimbursementNew(${id})`)

    // TODO : error handling
    const intakeRecords = await getRecordsWithTicketID(INTAKE_TABLE, fields["Ticket ID"])

    if (intakeRecords.length > 1) {
        console.error(`Multiple intake records exist for this ticket id: ${fields["Ticket ID"]}`)
    } else if (intakeRecords.length === 0) {
        console.error(`No intake records exist for this ticket id: ${fields["Ticket ID"]}`)
    } else {
        console.log("updating...")
        // Close the intake ticket
        // NOTE that this will trigger the intake ticket on complete function
        const [intakeID, , intakeMeta] = intakeRecords[0]
        await updateRecord(INTAKE_TABLE, intakeID, { "Status": "Complete" }, intakeMeta)
    }

    // TODO: send reimbursement message
}

// Processes all tickets in a table that have a new status
async function pollTable(table, statusToCallbacks) {
    const changedTickets = await getChangedRecords(table)

    if (changedTickets.length === 0) {
        return
    }

    // TODO : it is possible for us to miss a step in the intake ticket state transitions.
    // For example, an intake ticket should go from "Seeking Volunteer" -> "Assigned" -> 
    // "Complete". Since we only trigger on the current state, there is a race condition 
    // where we could miss the intermediate state (i.e. assigned).
    //
    // NOTE that the `meta` object is passed to all callbacks, which can make modifications to it.
    for (const [id, fields, meta] of changedTickets) {
        console.log(`Processing record: ${id}`)

        const status = fields["Status"]
        if (status in statusToCallbacks) {
            for (const cb of statusToCallbacks[status]) {
                // eslint-disable-next-line callback-return
                await cb(id, fields, meta)
            }
        } else {
            console.error(`Record has invalid status: ${status}`)
        }

        // Once we have processed all callbacks for a ticket, note that we have seen it,
        // and update its meta field
        meta["lastSeenStatus"] = fields["Status"] || null
        await updateRecord(table, id, {}, meta)
    }
}

// Runs every minute
module.exports = {
    poll: {
        intakeTickets: functions.pubsub.schedule('* * * * *').onRun(async () => {
            const STATUS_TO_CBS = {
                "Seeking Volunteer": [onNewIntake],
                "Assigned / In Progress": [onIntakeAssigned],
                "Complete": [onIntakeCompleted],
                "Not Bed-Stuy": [],
            }

            await pollTable(INTAKE_TABLE, STATUS_TO_CBS)
            return null
        }),
        reimbursements: functions.pubsub.schedule('* * * * *').onRun(async () => {
            const STATUS_TO_CBS = {
                "New": [onReimbursementNew],
                "In Progress": [],
                "Complete": [],
            }

            await pollTable(REIMBURSEMENTS_TABLE, STATUS_TO_CBS)
            return null
        }),
    }
}
