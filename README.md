# firebase functions

to deploy one set of functions:
`firebase deploy --only functions:[namespace]`

## config

https://firebase.google.com/docs/functions/config-env

config structure
```json
{
  "airtable": {
    "intake_messages_table": "",
    "intake_contacts_table": "",
    "api_key": "",
    "base_id": ""
  },
  "twilio": {
    "auth_token": "",
    "sid": ""
  }
}
```


## intake functions

twilio is weird and makes voicemails into something that requires 3 separate requests https://www.twilio.com/docs/voice/twiml/record (we can replace at least 1 with a static url)

https://firebase.google.com/docs/functions/http-events#use_middleware_modules_with