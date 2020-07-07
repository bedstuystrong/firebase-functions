const test = require('firebase-functions-test')()

const assert = require("assert")
const mocha = require("mocha")
const fs = require('fs')
const _ = require("lodash")

const GARAGE_CHAN_ID = "C0106GP18UT"
test.mockConfig(
    {
        "environment": {
            "type": "test"
        },
        "airtable": {
            "intake_contacts_table": "_test_intake_numbers",
            "api_key": "<REPLACE>",
            "base_id": "<REPLACE>",
            "intake_messages_table": "_test_sms_intake_messages",
            "inbound_table": "_test_inbound",
            "intake_table": "_test_intake",
        },
        "slack": {
            "token": "<REPLACE>",
            "northeast_bedstuy": GARAGE_CHAN_ID,
            "northwest_bedstuy": GARAGE_CHAN_ID,
            "southeast_bedstuy": GARAGE_CHAN_ID,
            "southwest_bedstuy": GARAGE_CHAN_ID,
            "delivery_volunteers": GARAGE_CHAN_ID,
        },
    }
)

const Slack = require("slack")
const { findInboundTicketForIntakeTicket, getAllIntakeTickets, getChangedIntakeTickets, getIntakeTicketsWithoutLinks } = require("../airtable")

const bot = new Slack({ "token": "<REPLACE>" })


describe("test get all intake tickets", () => {
    it("basic", async () => {
        const tickets = await getAllIntakeTickets()
        assert(tickets.length > 0)
    })
})

describe("test get all new tickets", () => {
    it("basic", async () => {
        const tickets = await getChangedIntakeTickets()
        console.log(tickets.length)
    })
})

describe("test slack", () => {
    it("list channels", async () => {
        const res = await bot.channels.list()
        const channels = res.channels

        for (const chan of channels) {
            if (chan.name === "garage") {
                return
            }
        }
    })

    it("send test message", async () => {
        const res = await bot.chat.postMessage({
            "channel": GARAGE_CHAN_ID,
            "text": "HELLO!",
        })
    })
})

describe("getIntakeTicketsWithoutLinks", () => {
    before(async () => {
        this.intakeTickets = await getIntakeTicketsWithoutLinks()
        fs.writeFileSync('test/data/intake-tickets-without-links.json', JSON.stringify(this.intakeTickets))
        Promise.resolve()
    })

    it("should return some tickets", () => {
        assert.ok(this.intakeTickets.length > 0)
    })

    it("should only find tickets without links", () => {
        _.each(this.intakeTickets, ([, fields,]) => {
            assert.strictEqual(undefined, fields['Phone/Text Inbound (For call back!)'])
        })
    })
})

describe("findInboundTicketForIntakeTicket", function () {
    this.timeout(60000)

    before(async () => {
        const data = fs.readFileSync('test/data/intake-tickets-without-links.json')
        const intakeTickets = JSON.parse(data.toString())
        this.results = await Promise.all(
            _.map(intakeTickets, async (ticket) => [ticket, await findInboundTicketForIntakeTicket(ticket)])
        )
        this.matchedResults = _.filter(this.results, ([, x]) => !_.isNil(x))
        this.unmatchedResults = _.filter(this.results, ([, x]) => _.isNil(x))
        Promise.resolve()
    })

    it("should find tickets with matching phone numbers", () => {
        const mismatchedPhoneNumber = _.filter(this.matchedResults, ([[, intakeFields,], [, inboundFields,]]) => (
            intakeFields.phoneNumber !== inboundFields.phoneNumber
        ))
        assert.deepEqual(mismatchedPhoneNumber, [])
    })

    it("should find tickets with matching intake volunteers", () => {
        const mismatchedIntakeVolunteer = _.filter(this.matchedResults, ([[, intakeFields,], [, inboundFields,]]) => (
            _.intersection(intakeFields.intakeVolunteer, inboundFields.intakeVolunteer).length !== 1
        ))
        const mismatches = _.map(mismatchedIntakeVolunteer, ([[, intakeFields,], [, inboundFields]]) => (
            {
                intakeID: intakeFields.ticketID,
                intakeVolunteer: intakeFields.intakeVolunteer,
                intakeDateCreated: intakeFields.dateCreated,
                inboundPhoneNumber: inboundFields.phoneNumber,
                inboundIntakeTime: inboundFields.intakeTime,
                inboundVolunteer: inboundFields.intakeVolunteer
            }
        ))
        assert.deepEqual(mismatches, [])
    })

    it("should not miss any tickets", () => {
        assert.strictEqual(0, this.unmatchedResults.length)
    })

    it("should not time travel", () => {
        const timeTravelers = _.filter(this.matchedResults, ([[, intakeFields,], [, inboundFields]]) => (
            Date.parse(intakeFields.dateCreated) < Date.parse(inboundFields.intakeTime)
        ))
        assert.deepEqual(timeTravelers, [])
    })
})