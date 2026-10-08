# dsh-openrouter-voice

Self-contained voice input via OpenRouter for DeepSeek Harness: **visually identical to the built-in composer voice control** — the same place, the same collapsed microphone button with a "Dictation" tooltip, the same expanded recording row (cancel, waveform, status, stop, insert / record again), and the same icons, styles, and strings. During dictation, the standard send button is visually replaced by **a single blue "Transcribe and send" button**: the exact same 34×34 size, color, up-arrow icon, hover effect, and disabled state.

Speech recognition is routed directly to the plugin's own channel talking to OpenRouter rather than `@deepseek-ai/dsh-experimental-*`. From public services, it requires `connection.rpc` (browser↔host transport), `sessions`, `conversation`, `slots`, and `locale` on the client, and an optional `credentials` on the host: if any of them changes in a future Harness update, the plugin remains inert rather than breaking app startup.

## Responsibilities

| Part | Responsibility |
| --- | --- |
| `lib/index.js` (host) | `connection.rpc` `/openrouter-voice` channel: OpenRouter transcription model catalog, model selection, key resolution, HTTP `POST /audio/transcriptions` calls, WAV validation, activation breadcrumbs |
| `lib/client.js` (browser) | Standard voice control (`MediaRecorder` → 16 kHz mono PCM16 WAV → channel → `inputActions.insertText`), "Transcribe and send" button (addressed `SessionFace.prompt`), and model picker row on the plugin's page |

UI mount points:

* **Composer** — slot `conversation.input.activity`, exactly where the built-in microphone sits: a compact action **immediately to the right of the model selector**. While recording, the standard send button is replaced by a single blue button that stops recording and sends the transcript in a dedicated message to the originating session alongside any pre-typed text. It remains disabled while requesting microphone access or transcribing. After completion, cancellation, or error, the standard send button returns. Draft text is preserved; if non-empty, the transcript is appended with a newline. Upon host confirmation, the draft is cleared only if it was not edited during send. Attachments remain in the draft and are not sent by this button. Visual replacement uses a copy of the built-in CSS rules and SVG arrow; the built-in button is hidden via a scoped CSS selector bound to this composer's capture row without altering Harness event listeners or DOM structure.
* **Plugins → dsh-openrouter-voice** — "Transcription model" row: one select with the live OpenRouter catalog (`GET /api/v1/models?output_modalities=transcription`) plus a "Custom ID…" option, always showing the unsaved draft. Only custom mode shows the standalone full-width ID field below the select. Its value is retained when switching to catalog models and back, including unsaved text, while this page remains open. Separate **Save** and **Refresh** text buttons persist the choice (with a saving state).

The model selection is stored in `$DSH_HOME/openrouter-voice.json` alongside host lifecycle breadcrumbs: `imported` → `applied` → `injected` → `registered` (plus `routes`, `base`), or upon failure — `failed` with reason and `inert`. This file makes diagnosing startup issues straightforward without reading process logs.

## Focus-independent recording

Recording continues while you speak, regardless of window focus: window `blur` and `visibilitychange` (switching browser tabs, minimizing the window) do not interrupt capture — `MediaRecorder` continues encoding in the background, and duration limits remain enforced. The waveform animation simply sleeps in the background (`requestAnimationFrame` pauses in hidden tabs) and resumes when you return.

## Tab switching preserves context

Recording and transcription belong to the **module**, not the mounted React component. On capture start, the plugin retains the originating session via public `sessions.retain`; switching tabs does not release it. "Transcribe and send" invokes `SessionFace.prompt` for that exact session and awaits host confirmation. The active draft text is read from its resident `conversation.input.for(binding.ctx).state`, never from whichever composer is currently visible on screen. After completion, error, or explicit cancellation, the session retention is released.

Regular "Stop" inserts text at the current cursor position **after transcription**: `captureInsertion()` is called immediately before `insertText()`. Edits during recording/transcription are fully supported. If the input is locked by an ongoing send or an error occurs, recognized text is retained in plugin memory for manual insertion in the original session.

Recording can be stopped via: the Stop button, the "Transcribe and send" button, `Escape`, the Cancel button, or reaching the duration limit.

When returning to a tab, the capture row remains fully expanded across the full width: the composer maintains its own expanded state flag and asserts it on every layout cycle.

## Immediate availability of new chats

The "New Chat" button in Harness reuses an existing empty chat in the workspace, and a chat is only marked non-empty after the host accepts its first prompt. Because voice transcription takes a few seconds, the chat remains empty during that window — previously, clicking "New Chat" would return you to the very chat being dictated into.

The plugin reserves the workspace's next empty chat using the same call (`sessions.create({ workspaceId })`) Harness uses when no empty chat exists. The button finds the reserved chat first and opens a clean new session, while the audio transcript continues processing into the originating session.

No reservation is made:
* if the chat already has message history;
* if an empty chat row already precedes the dictated chat in the list.

## Profile mounting

The package is a profile dependency, and the row is mounted via the profile's **user layer** (`cordis.patch.yml`):

```yaml
- insert:
    - id: openrouter-voice
      name: 'dsh-openrouter-voice'
```

Installation (using `link:` for local development so edits in `lib/` take effect immediately):

```sh
cd ~/.dsh/profiles/desktop
pnpm add link:../dsh-openrouter-voice
```

All row configuration fields are optional:

```yaml
- id: openrouter-voice
  name: 'dsh-openrouter-voice'
  config:
    model: google/gemini-3.5-transcribe   # initial model if no state file exists
    language: auto                        # auto or ISO-639-1 hint
    baseURL: https://openrouter.ai/api/v1
    apiKeyRef: OPENROUTER_API_KEY         # credential reference or env var
    maxAudioBytes: 8388608
    maxDurationSeconds: 180
    inferenceTimeoutMs: 120000
    modelsCacheMs: 600000
```

The API key is read from the `credentials` service (`$DSH_HOME/.credentials.yaml`) with fallback to the environment variable, so key rotation takes effect on the next recording without restarting.

## Transport

The browser communicates over the shared `/api` channel (`connection.rpc.call('/api', …)`), and the host owns **exact Fetch routes under it**: `/api/openrouter-voice/<endpoint>`.

Standard carrier framing is used:
Request: `{ type: 'client-request', rpcId, method, payload }`
Response: `{ type: 'server-response', rpcId, result }` where `result` is the plugin envelope.

Endpoint responses follow `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`:

| Endpoint | Payload | Value |
| --- | --- | --- |
| `config` | `{}` | Current model, API key presence flag, size and duration limits, catalog cache |
| `models` | `{ force?: boolean }` | List of OpenRouter transcription models |
| `set-model` | `{ model }` | Saved configuration |
| `reset-model` | `{}` | Configuration with default model |
| `transcribe` | `{ audioBase64, model?, language? }` | `{ text, audioSeconds, inferenceSeconds, model }` |

## Compatibility

The `conversation.input.activity` slot is single-occupancy: if the experimental `@deepseek-ai/dsh-experimental-voice-input-bundle` is enabled in the profile, it already occupies this slot. To use this plugin with its standard look, disable the experimental voice bundle.

## Testing

```sh
pnpm test        # node test/host.mjs && node --import ./test/register.mjs test/client.mjs
```

* `test/host.mjs` — Channel protocol, catalog cache, state file, WAV parsing, OpenRouter request construction, error mapping with mocked network.
* `test/client.mjs` — Real bundle mounted via fake `window.__ModuleLoader__`, React and DSH primitives, `SlotCore`, jsdom, and mocked microphone stack: slot registration, collapsed button → expanded recording row with waveform, Stop (insert without sending), addressed send with host confirmation, session retention, the model row (catalog select, custom-ID mode, save/refresh), window blur/visibility behavior, and Escape cancellation.
* `test/live.mjs` — Live test against OpenRouter using the key from `$DSH_HOME/.credentials.yaml`:

  ```sh
  say -o /tmp/voice.aiff 'DeepSeek Harness OpenRouter voice check.'
  afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/voice.aiff /tmp/voice.wav
  node test/live.mjs /tmp/voice.wav
  ```
