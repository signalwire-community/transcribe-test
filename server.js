import 'dotenv/config';
import express from 'express';

const {
  SIGNALWIRE_SPACE,
  SIGNALWIRE_PROJECT_ID,
  SIGNALWIRE_API_TOKEN,
  PUBLIC_BASE_URL,
  TARGET_NUMBER = '+18004444444',
  FROM_NUMBER = '',
  TRANSCRIBE_LANG = 'en-US',
  TRANSCRIBE_ENGINE = 'deepgram',
  TRANSCRIBE_LIVE_EVENTS = 'true',
  TRANSCRIBE_AI_SUMMARY = 'false',
  PORT = 3000,
} = process.env;

const required = { SIGNALWIRE_SPACE, SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN, PUBLIC_BASE_URL };
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')} — copy .env.example to .env and fill it in.`);
  process.exit(1);
}

const base = PUBLIC_BASE_URL.replace(/\/$/, '');
const apiBase = `https://${SIGNALWIRE_SPACE}.signalwire.com/api/calling/calls`;
const authHeader = 'Basic ' + Buffer.from(`${SIGNALWIRE_PROJECT_ID}:${SIGNALWIRE_API_TOKEN}`).toString('base64');
const bool = (v) => String(v).toLowerCase() === 'true';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const log = (tag, obj) =>
  console.log(`\n[${new Date().toISOString()}] ${tag}\n${JSON.stringify(obj, null, 2)}`);

// Calls we have already kicked transcription on, so a repeated `connected`
// status callback doesn't start a second session.
const transcribing = new Set();

// --- 1. SWML: answer the inbound call and connect it to the MCI test number --
app.all('/swml', (req, res) => {
  log('INBOUND SWML REQUEST', { method: req.method, body: req.body });

  const connect = {
    to: TARGET_NUMBER,
    status_url: `${base}/connect-status`,
    answer_on_bridge: false,
  };
  if (FROM_NUMBER) connect.from = FROM_NUMBER;

  const swml = {
    version: '1.0.0',
    sections: {
      main: [
        { answer: {} },
        { connect },
        { hangup: {} },
      ],
    },
  };

  log('SERVING SWML', swml);
  res.json(swml);
});

// --- 2. connect status_url: start live_transcribe once the legs are bridged --
app.post('/connect-status', async (req, res) => {
  const params = req.body?.params ?? {};
  const { call_id: callId, connect_state: state, peer } = params;

  log('CONNECT STATUS', {
    connect_state: state,
    inbound_call_id: callId,
    peer_call_id: peer?.call_id,
  });

  // Ack immediately — SignalWire doesn't need to wait on our REST call.
  res.sendStatus(200);

  if (state !== 'connected' || !callId) return;
  if (transcribing.has(callId)) {
    console.log(`  ↳ live_transcribe already started for ${callId}, skipping`);
    return;
  }
  transcribing.add(callId);

  await startLiveTranscribe(callId);
});

async function startLiveTranscribe(callId) {
  const payload = {
    command: 'calling.live_transcribe',
    id: callId,
    params: {
      action: {
        start: {
          webhook: `${base}/transcription`,
          lang: TRANSCRIBE_LANG,
          // Both legs of the bridge: the inbound caller and the MCI side.
          direction: ['remote-caller', 'local-caller'],
          live_events: bool(TRANSCRIBE_LIVE_EVENTS),
          ai_summary: bool(TRANSCRIBE_AI_SUMMARY),
          speech_engine: TRANSCRIBE_ENGINE,
        },
      },
    },
  };

  log('POST live_transcribe →', { url: apiBase, payload });

  try {
    const resp = await fetch(apiBase, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    log(`live_transcribe RESPONSE ${resp.status}`, safeJson(text));
    if (!resp.ok) transcribing.delete(callId);
  } catch (err) {
    console.error('live_transcribe request failed:', err);
    transcribing.delete(callId);
  }
}

// --- 3. transcription webhook -----------------------------------------------
app.post('/transcription', (req, res) => {
  log('TRANSCRIPTION EVENT', req.body);
  res.sendStatus(200);
});

app.get('/health', (_req, res) => res.json({ ok: true, target: TARGET_NUMBER, base }));

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`  SWML endpoint      ${base}/swml        <- point your number here`);
  console.log(`  connect status_url ${base}/connect-status`);
  console.log(`  transcript webhook ${base}/transcription`);
  console.log(`  dialing            ${TARGET_NUMBER}`);
});

function safeJson(text) {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
