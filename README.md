# Glue Lock for Homey

Homey app that controls Glue smart locks through the Glue cloud API.

- One device per lock: lock/unlock, battery, online status, last event
- Log in with your Glue account; only an API key is stored, never the password
- Flow action "Lock all doors" with a verification step and a trigger "A lock could not be locked"

## Development

```
npm install --global homey
homey login
homey app run        # run on your Homey with live logs
homey app install    # install permanently
npm test             # unit tests
homey app validate --level publish
```

The unofficial Glue API is documented only informally. This project is not affiliated with Glue.

## Credits

Originally created by Kim Kokholm (HarpunDK/Homey.Glue, GPL-3.0), who handed the app over to its current maintainer. Thank you, Kim.
