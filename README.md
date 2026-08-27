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

`direction` is what makes it cover both legs, and the labels are **relative to
the call SID you pass**, not to who originated the call. Verified by testing on
this inbound flow: `remote-caller` is the human who dialed in, `local-caller` is
MCI (the bridged B-leg). See the direction mapping section below.

## Notes

- `status_url` fires for `connecting`, `connected`, `failed`, `disconnected`.
  Only `connected` triggers transcription; a `Set` guards against duplicates.
- To stop early, POST the same endpoint with `"action": "stop"`.
- Everything inbound is logged as pretty JSON so you can watch the flow live.

## Testing with ngrok

Verified end-to-end on 2026-08-27 against space `lpradovera`.

Order matters: `PUBLIC_BASE_URL` is read once at boot (`server.js:32`) and baked
into the SWML `status_url` and the transcription webhook, so the tunnel has to
be up and in `.env` *before* `npm start`.

**1. Tunnel** (terminal 1)

```bash
ngrok http 3000
```

Copy the `https://...ngrok-free.dev` forwarding URL.

**2. Point the app at it and run it** (terminal 2)

```bash
sed -i '' "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://YOUR-URL.ngrok-free.dev|" .env
npm start
```

The startup banner echoes the three public URLs — confirm they show the new
host. A stale value here is the most common failure.

**3. Point the number at it** — `<space>.signalwire.com` → Phone Numbers → your
number → Voice Settings:

- Handle calls using: **SWML Script** → **External URL**
- URL: `https://YOUR-URL.ngrok-free.dev/swml`

**4. Sanity check before dialing**

```bash
curl -s https://YOUR-URL.ngrok-free.dev/health
# {"ok":true,"target":"+18004444444","base":"https://YOUR-URL.ngrok-free.dev"}

curl -s -X POST https://YOUR-URL.ngrok-free.dev/swml -H 'Content-Type: application/json' -d '{}'
# SWML JSON with status_url on the tunnel host
```

Both pass through the free-tier tunnel without the ngrok browser interstitial —
it only fires for browser-style requests, not SignalWire's fetcher or curl. If
you do open an endpoint in a browser, send `ngrok-skip-browser-warning: 1`.

**5. Call the number.** Expected log sequence:

1. `INBOUND SWML REQUEST` → `SERVING SWML`
2. `CONNECT STATUS` — `connecting`, then `connected` (MCI recording audible)
3. `POST live_transcribe →` → `live_transcribe RESPONSE 200`
4. `TRANSCRIPTION EVENT` — talk yourself as well, to confirm both directions are
   captured: your speech arrives as `remote-caller`, MCI's as `local-caller`

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| Nothing logged at all | Number not pointed at `/swml`, or set to LaML instead of SWML |
| SWML served, no `CONNECT STATUS` | Stale `PUBLIC_BASE_URL` — the tunnel died or `.env` was edited without restarting; SignalWire got a dead `status_url` |
| `CONNECT STATUS` stuck at `connecting` / goes to `failed` | Outbound leg to `TARGET_NUMBER` never bridged; check `FROM_NUMBER` / number capabilities |
| `live_transcribe RESPONSE 401` | `SIGNALWIRE_PROJECT_ID` / `SIGNALWIRE_API_TOKEN` pair |
| `live_transcribe RESPONSE 404` | Call SID already gone — the leg hung up before the REST call landed |
| `RESPONSE 200` but no transcript events | `TRANSCRIBE_LIVE_EVENTS` is `false`, or the webhook URL is on a dead tunnel |

http://localhost:4040 (ngrok's inspector) shows full request and response bodies
for every webhook — fastest way to see what SignalWire actually posted.

## What the docs actually say (and don't)

Researched 2026-08-27 against the current SignalWire docs. Each answer is
labelled **[documented]**, **[inferred]**, or **[unverified]** so nothing here
gets mistaken for a guarantee.

### 1. Which event means the bridge is actually established?

**[documented]** `status_url` receives HTTP POSTs whose event type is always
`calling.call.connect`. The field to switch on is `params.connect_state`:

| `connect_state` | Meaning (per docs) |
|---|---|
| `connecting` | Attempting to establish connection |
| `connected` | **Successfully bridged** |
| `failed` | Connection unsuccessful — `params.failed_reason` is populated |
| `disconnected` | Connection ended |

`params.peer` (with `peer.call_id`, `peer.node_id`, `peer.tag`, `peer.device`)
is only present on `connected`, so `connect_state === "connected"` **and** a
populated `peer` is the reliable "B-leg accepted, bridge is up" signal. That is
what `/connect-status` keys on.

**Caveat, quoted verbatim from the `connect` reference:** *"Status callbacks are
asynchronous, best-effort HTTP notifications: delivery can be delayed or fail
silently."* The docs recommend confirming state via the REST API before critical
actions rather than relying solely on callbacks. So the event *means* bridged;
its *arrival* is not guaranteed.

### 2. Does `answer_on_bridge: true` prevent `connected` on failed outcomes?

**[documented, partially]** The docs define `answer_on_bridge` as exactly one
thing: *"Delay answer until the B-leg answers."* It controls when the **A-leg**
is answered (ringback / billing), and says nothing about status events.

**[inferred]** It is not the mechanism that protects you here — `connect_state`
already does. No-answer, busy, declined and timeout are all "connection
unsuccessful" outcomes, which the enum maps to `failed` (with `failed_reason`),
not `connected`. The SWML return variables agree: `connect_result` is only
`"connected"` or `"failed"`, with `connect_failed_reason` on failure. So
`connected` should not fire for those outcomes with `answer_on_bridge` either
way.

**[unverified]** We have not exercised busy / no-answer / decline against this
app. If you need certainty rather than enum semantics, force each outcome once
and read the logged payloads — the app pretty-prints every callback.

### 3. Which call ID goes in the REST `id` field?

**[documented]** Only this much: `id` is *"The unique identifying ID of a
existing call"*. Neither the Call Commands reference nor the `connect` reference
says which leg to target for a bridged call. There is no documented answer.

**[inferred]** This app uses `params.call_id` — the A-leg, the call that is
executing the SWML — not `peer.call_id`. That matches how SignalWire's own
example runs transcription (see below): on the call handling the SWML, not on
the peer. `peer.call_id` would scope you to the B-leg only.

### 4. Does one call ID with both directions cover both sides?

**[documented]** The direction values are defined as:

- `remote-caller` — *"The far-end participant's audio"*
- `local-caller` — *"The originating participant's audio"*

The `live_transcribe` reference explicitly **does not** clarify behaviour on
bridged or multi-party calls.

**[inferred]** SignalWire's Call Fabric article passes both values on the
SWML-executing call while connecting to a Fabric resource, and describes it as
capturing both the inbound caller and the connected resource — so both sides of
the bridge on one ID is the intended usage.

**[verified by testing]** Yes, both sides are covered on the single A-leg SID —
and the mapping is the **opposite** of what the doc wording suggests:

| direction | Who it actually is (inbound PSTN → connect) |
|---|---|
| `remote-caller` | The human who dialed in |
| `local-caller` | MCI — the bridged B-leg |

The labels are relative to **the call leg you passed as `id`**, not to who
originated the call:

- `remote-caller` = the party at the far end of *that leg* from SignalWire. On
  an inbound call that is the PSTN caller.
- `local-caller` = the audio SignalWire puts *into* that leg — normally its own
  playback/TTS, and once bridged, the peer's audio.

Read that way the doc phrase *"the originating participant's audio"* means the
audio originating from the SignalWire side of the leg, not the person who
originated the call. This is the trap: the naive reading gets it exactly
backwards.

Consequence: had transcription been started on `peer.call_id` (the B-leg)
instead, the mapping would flip. Since this app passes both values it captures
everything either way, but the labels on each `TRANSCRIPTION EVENT` are only
interpretable if you know which SID the session was attached to.

### 5. Is there an official example of this exact pattern?

**No** — no official example of `status_url` → REST `calling.live_transcribe`
was found. The closest official example inverts the order: SignalWire's
[Call Fabric transcription article](https://signalwire.com/blogs/developers/resources-and-transcribing-conversations)
puts `live_transcribe` **inline in the SWML, before `connect`**:

```json
{ "live_transcribe": { "action": { "start": {
    "webhook": "<your-webhook>/transcription",
    "direction": ["remote-caller", "local-caller"]
} } } },
{ "connect": { "from": "${call.from}", "to": "/private/<resource-name>" } }
```

Transcription starts at the top of call handling and the article states it
continues across the bridge to the connected resource. That approach needs no
status callback, no REST call, and no call-ID choice — it removes questions 1–3
entirely, and it is the pattern SignalWire actually documents. The tradeoff is
that it transcribes from before the bridge exists (including any pre-connect
audio) and cannot be conditioned on the bridge succeeding.

This harness deliberately tests the REST-after-bridge variant, which is why it
sits on inferred rather than documented behaviour in places.

### Sources

- [`connect` reference](https://signalwire.com/docs/swml/reference/connect)
- [`live_transcribe` reference](https://signalwire.com/docs/swml/reference/calling/live-transcribe.md)
- [Send call commands (REST)](https://signalwire.com/docs/apis/rest/calls/call-commands)
- [Call Fabric: Resources and Transcribing Conversations](https://signalwire.com/blogs/developers/resources-and-transcribing-conversations)
