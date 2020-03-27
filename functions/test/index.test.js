const test = require('firebase-functions-test')()

const assert = require("assert")
const mocha = require("mocha")

const GARAGE_CHAN_ID = "C0106GP18UT"
test.mockConfig(
    {
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
            "northeast_bedstuy": GARAGE_CHAN,
            "northwest_bedstuy": GARAGE_CHAN,
            "southeast_bedstuy": GARAGE_CHAN,
            "southwest_bedstuy": GARAGE_CHAN,
        },
    }
)

const Slack = require("slack")
const { getAllIntakeTickets, getChangedIntakeTickets } = require("../airtable")

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