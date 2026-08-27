# SignalWire live_transcribe test harness

Inbound call → SWML `connect` to the MCI test number (+1 800 444 4444) → on
`connect_state: connected` the app starts `live_transcribe` on the inbound call
SID via the REST API, covering both directions of the bridge.

## Setup

```bash
npm install
cp .env.example .env   # fill in space / project / token / public URL
npm start
```

Expose it (e.g. `ngrok http 3000`), put that hostname in `PUBLIC_BASE_URL`,
then point your SignalWire phone number's voice handler at:

```
https://<your-public-host>/swml
```

as an **SWML webhook** (External URL / SWML Script → external URL).

## Endpoints

| Path | Who calls it | What it does |
|---|---|---|
| `/swml` | SignalWire, on inbound call | Returns `answer` + `connect` to `TARGET_NUMBER` with `status_url` |
| `/connect-status` | SignalWire, connect lifecycle | On `connected`, POSTs `calling.live_transcribe` for the inbound call ID |
| `/transcription` | SignalWire, transcription engine | Logs live transcript events / AI summary |
| `/health` | you | sanity check |

## The REST call it makes

```
POST https://<space>.signalwire.com/api/calling/calls
Authorization: Basic base64(project_id:api_token)

{
  "command": "calling.live_transcribe",
  "id": "<inbound call SID from status_url params.call_id>",
  "params": {
    "action": {
      "start": {
        "webhook": "<PUBLIC_BASE_URL>/transcription",
        "lang": "en-US",
        "direction": ["remote-caller", "local-caller"],
        "live_events": true,
        "ai_summary": false,
        "speech_engine": "deepgram"
      }
    }
  }
}
```

`direction` is what makes it cover both legs — `remote-caller` is the far end
(MCI) and `local-caller` is the party that dialed in. Both are attached to the
single inbound call SID.

## Notes

- `status_url` fires for `connecting`, `connected`, `failed`, `disconnected`.
  Only `connected` triggers transcription; a `Set` guards against duplicates.
- To stop early, POST the same endpoint with `"action": "stop"`.
- Everything inbound is logged as pretty JSON so you can watch the flow live.
