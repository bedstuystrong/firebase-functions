const assert = require("assert")
const test = require('firebase-functions-test')()

const mocha = require("mocha")

test.mockConfig(
    {
        "airtable": {
            "intake_contacts_table": "_test_intake_numbers",
            "api_key": "<REPLACE>",
            "base_id": "<REPLACE>",
            "intake_messages_table": "_test_sms_intake_messages",
            "inbound_table": "_test_inbound",
            "intake_table": "_test_intake"
        },
    }
)

const { getAllIntakeTickets, getChangedIntakeTickets } = require("../airtable")


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