/**
 * OpenRouter voice transcription for DeepSeek Harness — one self-contained
 * plugin.
 *
 * It deliberately shares no code with the harness's experimental speech
 * stack: it owns the browser microphone control, the Connection RPC channel,
 * the OpenRouter call, the transcription-model catalog and the settings row
 * that selects the model. Its only harness dependencies are the Connection
 * carrier (`ctx.connection.rpc.handle`) and, optionally, the credentials
 * service; both are resolved defensively, so an incompatible harness leaves
 * the plugin inert instead of failing the boot.
 *
 * @module dsh-openrouter-voice
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Plugin id; the bundle patch mounts this row under the same id. */
export const name = 'openrouter-voice'
/** The RPC carrier is the only service this plugin requires. */
export const inject = ['connection']
/** Plugin version, recorded with the activation breadcrumb. */
const VERSION = '0.2.0'

/** Endpoint prefix the browser sends; the host owns one exact route per endpoint. */
const ROUTE = 'openrouter-voice'
/** Absolute path prefix of the Fetch routes this plugin owns under `/api`. */
const ROUTE_BASE = `/api/${ROUTE}`
/** Endpoints served under {@link ROUTE_BASE}; the path suffix doubles as the endpoint name. */
const ENDPOINTS = ['config', 'models', 'set-model', 'reset-model', 'transcribe']
/** Committed defaults; the live model selection lives in the state file. */
const DEFAULTS = {
  model: 'google/gemini-3.5-transcribe',
  language: 'auto',
  baseURL: 'https://openrouter.ai/api/v1',
  apiKeyRef: 'OPENROUTER_API_KEY',
  maxAudioBytes: 8 * 1024 * 1024,
  maxDurationSeconds: 180,
  inferenceTimeoutMs: 120_000,
  modelsCacheMs: 600_000,
}

/** A failure the browser is allowed to see, with a stable code. */
class VoiceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'VoiceError'
    this.code = code
  }
}

/** @returns the harness home, honouring `DSH_HOME` like every other plugin. */
function dshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured.trim() !== '' ? configured : join(homedir(), '.dsh')
}

/** @returns the state file path holding the live model selection. */
function statePath() {
  return join(dshHome(), 'openrouter-voice.json')
}

/**
 * Read the persisted selection. A missing, unreadable or malformed file is a
 * normal state, never a failure: the committed defaults then apply.
 * @returns the stored object, or undefined.
 */
function readState() {
  try {
    const path = statePath()
    if (!existsSync(path)) return void 0
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : void 0
  } catch {
    return void 0
  }
}

/**
 * Merge a patch into the persisted selection.
 * @param patch - fields to write.
 * @returns the merged state after the write attempt.
 */
function writeState(patch) {
  const next = { ...(readState() ?? {}), ...patch }
  try {
    const path = statePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch (error) {
    throw new VoiceError('state-unwritable', `Could not save the OpenRouter voice settings: ${messageOf(error)}`)
  }
  return next
}

/** @param error - anything thrown. @returns a printable message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param value - candidate. @returns whether it is a plain record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param value - candidate. @returns a trimmed string, or undefined. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : void 0
}

/** @param value - candidate. @returns a positive integer, or undefined. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0
}

/**
 * Resolve the effective configuration: committed defaults, the row config, and
 * the persisted state file, in that order.
 * @param config - raw row configuration, possibly undefined.
 * @returns the effective configuration.
 */
function settingsOf(config) {
  const row = isRecord(config) ? config : {}
  const state = readState() ?? {}
  const pick = (key) => text(state[key]) ?? text(row[key]) ?? DEFAULTS[key]
  const pickCount = (key) => count(state[key]) ?? count(row[key]) ?? DEFAULTS[key]
  return {
    model: pick('model'),
    language: pick('language'),
    baseURL: stripTrailingSlash(pick('baseURL')),
    apiKeyRef: pick('apiKeyRef'),
    maxAudioBytes: pickCount('maxAudioBytes'),
    maxDurationSeconds: pickCount('maxDurationSeconds'),
    inferenceTimeoutMs: pickCount('inferenceTimeoutMs'),
    modelsCacheMs: pickCount('modelsCacheMs'),
  }
}

/** @param value - URL-ish string. @returns it without a trailing slash. */
function stripTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

/**
 * Read the current credential behind one reference. A rotated key reaches the
 * next recording without a restart, and a missing store falls back to the
 * process environment.
 * @param ctx - plugin context, which may compose no credentials service.
 * @param ref - POSIX shell identifier naming the secret.
 * @returns the stored value.
 */
async function apiKey(ctx, ref) {
  let stored
  try {
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : void 0
    stored = credentials !== void 0 ? await credentials.resolve(ref) : void 0
  } catch {
    stored = void 0
  }
  const value = text(stored?.value) ?? text(process.env[ref])
  if (value === void 0) {
    throw new VoiceError(
      'missing-credential',
      `No credential for ${ref}: store it through the harness credentials (the Models page writes it) or export ${ref}`,
    )
  }
  return value
}

/**
 * Validate one canonical recording and measure it.
 *
 * The browser half always sends 16 kHz mono PCM16, but the walk over the RIFF
 * chunks keeps the check honest for anything else that reaches the channel.
 * @param audio - WAV bytes.
 * @param maxSeconds - longest accepted recording.
 * @returns the recording duration in seconds.
 */
function validateWave(audio, maxSeconds) {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new VoiceError('invalid-audio', 'Recording is not a RIFF/WAVE file')
  }
  let offset = 12
  let format
  let dataBytes
  while (offset + 8 <= audio.length) {
    const id = audio.toString('ascii', offset, offset + 4)
    const size = audio.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && size >= 16 && body + 16 <= audio.length) {
      format = {
        codec: audio.readUInt16LE(body),
        channels: audio.readUInt16LE(body + 2),
        sampleRate: audio.readUInt32LE(body + 4),
        bits: audio.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      dataBytes = Math.min(size, Math.max(0, audio.length - body))
      if (format !== void 0) break
    }
    offset = body + size + (size % 2)
  }
  if (format === void 0 || dataBytes === void 0) throw new VoiceError('invalid-audio', 'Recording has no fmt/data chunk')
  if (format.codec !== 1 || format.bits !== 16) throw new VoiceError('invalid-audio', 'Recording must be uncompressed PCM16 audio')
  if (format.channels < 1 || format.sampleRate < 8000) throw new VoiceError('invalid-audio', 'Recording has an unsupported sample rate or channel count')
  const frameBytes = format.channels * (format.bits / 8)
  const seconds = dataBytes / frameBytes / format.sampleRate
  if (seconds > maxSeconds) {
    throw new VoiceError('too-long', `Recording is ${seconds.toFixed(1)}s; the limit is ${maxSeconds}s`)
  }
  return seconds
}

/**
 * Fetch the OpenRouter catalog of transcription models.
 * @param settings - effective configuration.
 * @returns the normalized model list.
 */
async function fetchModels(settings) {
  const url = `${settings.baseURL}/models?output_modalities=transcription`
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    throw new VoiceError('catalog-failed', `OpenRouter model catalog failed (HTTP ${response.status})`)
  }
  const payload = await response.json()
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const models = []
  for (const row of rows) {
    const id = text(row?.id)
    if (id === void 0) continue
    const pricing = isRecord(row.pricing) ? row.pricing : {}
    models.push({
      id,
      name: text(row.name) ?? id,
      contextLength: count(row.context_length) ?? 0,
      promptPrice: text(pricing.prompt) ?? '',
    })
  }
  models.sort((left, right) => left.id.localeCompare(right.id))
  return { models, fetchedAt: Date.now() }
}

/**
 * Describe the current selection for the settings row.
 * @param ctx - plugin context for the credential probe.
 * @param settings - effective configuration.
 * @param cache - current catalog cache, possibly empty.
 * @returns the observable configuration.
 */
async function describe(ctx, settings, cache) {
  let hasKey = false
  try {
    await apiKey(ctx, settings.apiKeyRef)
    hasKey = true
  } catch {
    hasKey = false
  }
  return {
    model: settings.model,
    defaultModel: DEFAULTS.model,
    language: settings.language,
    apiKeyRef: settings.apiKeyRef,
    hasKey,
    maxAudioBytes: settings.maxAudioBytes,
    maxDurationSeconds: settings.maxDurationSeconds,
    models: cache?.models ?? [],
    modelsFetchedAt: cache?.fetchedAt ?? null,
    statePath: statePath(),
  }
}

/**
 * Transcribe one complete recording through OpenRouter's dedicated audio
 * endpoint.
 * @param ctx - plugin context for the credential lookup.
 * @param settings - effective configuration.
 * @param input - `audioBase64`, plus optional `model` and `language`.
 * @param signal - caller cancellation.
 * @returns the transcript and its measurements.
 */
async function transcribe(ctx, settings, input, signal) {
  signal?.throwIfAborted?.()
  const encoded = text(input.audioBase64)
  if (encoded === void 0) throw new VoiceError('invalid-audio', 'No recording was sent')
  if (encoded.length > Math.ceil(settings.maxAudioBytes / 3) * 4) {
    throw new VoiceError('too-long', `Recording exceeds the ${settings.maxAudioBytes} byte limit`)
  }
  const audio = Buffer.from(encoded, 'base64')
  if (audio.length === 0 || audio.toString('base64') !== encoded) {
    throw new VoiceError('invalid-audio', 'Audio must use canonical base64 encoding')
  }
  if (audio.length > settings.maxAudioBytes) {
    throw new VoiceError('too-long', `Recording exceeds the ${settings.maxAudioBytes} byte limit`)
  }
  const audioSeconds = validateWave(audio, settings.maxDurationSeconds)
  const model = text(input.model) ?? settings.model
  const language = text(input.language) ?? settings.language
  const key = await apiKey(ctx, settings.apiKeyRef)
  signal?.throwIfAborted?.()

  const startedAt = performance.now()
  const deadline = AbortSignal.timeout(settings.inferenceTimeoutMs)
  const signals = signal === void 0 || signal === null ? [deadline] : [signal, deadline]
  let response
  try {
    response = await fetch(`${settings.baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        input_audio: { data: audio.toString('base64'), format: 'wav' },
        ...(language === 'auto' ? {} : { language }),
      }),
      signal: AbortSignal.any(signals),
    })
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason ?? error
    if (deadline.aborted) {
      throw new VoiceError('timeout', `OpenRouter transcription timed out after ${settings.inferenceTimeoutMs} ms`)
    }
    throw new VoiceError('network', `OpenRouter request failed: ${messageOf(error)}`)
  }

  const raw = await response.text()
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = void 0
  }
  if (!response.ok) {
    const reported = text(payload?.error?.message) ?? text(payload?.message)
    throw new VoiceError(
      'provider-failed',
      `OpenRouter transcription failed (HTTP ${response.status})${reported === void 0 ? '' : `: ${reported}`}`,
    )
  }
  const resultText = typeof payload?.text === 'string' ? payload.text : void 0
  if (resultText === void 0) {
    throw new VoiceError('provider-failed', `OpenRouter returned no text field: ${raw.slice(0, 200)}`)
  }
  signal?.throwIfAborted?.()
  return {
    text: resultText.trim(),
    audioSeconds,
    inferenceSeconds: (performance.now() - startedAt) / 1000,
    model,
  }
}

/** @param value - handler value. @returns a Connection success envelope. */
function ok(value) {
  return { ok: true, value }
}

/**
 * @param code - stable machine code.
 * @param message - user-facing message.
 * @param details - optional structured context for the caller.
 * @returns a Connection failure envelope.
 */
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/**
 * Build the channel handler. Every endpoint returns the plugin's own
 * `{ ok, value }` / `{ ok, error }` envelope, wrapped in the Connection result
 * shape so the browser reads one consistent protocol.
 * @param ctx - plugin context.
 * @param rowConfig - raw row configuration.
 * @returns the Connection RPC handler.
 */
function createHandler(ctx, rowConfig) {
  let cache
  return async function handle(endpoint, payload, signal) {
    const settings = settingsOf(rowConfig)
    const input = isRecord(payload) ? payload : {}
    try {
      switch (endpoint) {
        case 'config':
          return ok(await describe(ctx, settings, cache))
        case 'models': {
          const fresh = cache !== void 0 && Date.now() - cache.fetchedAt < settings.modelsCacheMs
          if (!fresh || input.force === true) cache = await fetchModels(settings)
          return ok({ models: cache.models, fetchedAt: cache.fetchedAt, cached: fresh })
        }
        case 'set-model': {
          const model = text(input.model)
          if (model === void 0) throw new VoiceError('invalid-request', 'set-model needs a non-empty model id')
          writeState({ model })
          return ok(await describe(ctx, settingsOf(rowConfig), cache))
        }
        case 'reset-model': {
          writeState({ model: DEFAULTS.model })
          return ok(await describe(ctx, settingsOf(rowConfig), cache))
        }
        case 'transcribe':
          return ok(await transcribe(ctx, settings, input, signal))
        default:
          return fail('unknown-endpoint', `Unknown OpenRouter voice endpoint ${JSON.stringify(endpoint)}`)
      }
    } catch (error) {
      if (error instanceof VoiceError) return fail(error.code, error.message)
      return fail('internal', messageOf(error))
    }
  }
}

/**
 * Serve one {@link Request} of the browser RPC envelope.
 *
 * The browser carrier posts `{ type: 'client-request', rpcId, method, payload }`
 * and reads `{ type: 'server-response', rpcId, result }`, where `result` is the
 * very envelope this plugin already answers with. Reproducing that shape is all
 * it takes to be a valid endpoint on the shared channel.
 * @param request - the carrier's buffered POST.
 * @param wire - the endpoint name the browser sends, prefix included.
 * @param endpoint - bare endpoint name this route dispatches on.
 * @param handler - plugin channel handler.
 * @returns the framed response.
 */
async function serveEnvelope(request, wire, endpoint, handler) {
  let body
  try {
    body = await request.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  if (!isRecord(body) || body.type !== 'client-request' || typeof body.rpcId !== 'string') {
    return new Response('invalid client-request envelope', { status: 400 })
  }
  if (body.method !== wire) {
    return Response.json({
      type: 'server-response',
      rpcId: body.rpcId,
      result: fail('bad-request', `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(wire)}`),
    })
  }
  let result
  try {
    result = await handler(endpoint, body.payload, request.signal)
  } catch (error) {
    result = fail('internal', messageOf(error))
  }
  return Response.json({ type: 'server-response', rpcId: body.rpcId, result })
}

/**
 * Mount the plugin.
 *
 * The browser is served through **exact Fetch routes under `/api`**: that is
 * the one extension point a third-party plugin can own. A custom RPC *channel*
 * cannot be used here — the carrier registers a channel as a physical route
 * through `owner.webServer`, and the owning context of that service does not
 * inject the web server, so `rpc.handle` throws with "cannot get property
 * webServer without inject" and the browser sees `HTTP 405` on the channel
 * path. Exact Fetch routes (`connection.fetch.register`) avoid `webServer`
 * entirely and are consulted by the shared `/api` handler before the gateway
 * interceptor.
 * @param ctx - plugin context.
 * @param config - raw row configuration.
 */
export function apply(ctx, config) {
  markStage('applied')
  ctx.inject(['connection'], (inner) => {
    markStage('injected')
    const registry = inner.connection?.fetch
    if (typeof registry?.register !== 'function') {
      markStage('inert', { reason: 'the Connection carrier exposes no Fetch route registry' })
      console.warn('[openrouter-voice] the harness Connection carrier exposes no Fetch route registry; the plugin stays inert')
      return
    }
    const handler = createHandler(inner, config)
    const disposers = []
    try {
      for (const endpoint of ENDPOINTS) {
        const dispose = registry.register({
          path: `${ROUTE_BASE}/${endpoint}`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => serveEnvelope(request, `${ROUTE}/${endpoint}`, endpoint, handler),
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      markStage('registered', { routes: ENDPOINTS.length, base: ROUTE_BASE })
      inner.effect(() => () => {
        for (const dispose of disposers) {
          try {
            const released = dispose()
            if (released !== void 0 && typeof released.then === 'function') released.catch(() => void 0)
          } catch (error) {
            console.warn('[openrouter-voice] could not release an RPC route', error)
          }
        }
      }, 'openrouter-voice: RPC routes')
    } catch (error) {
      markStage('failed', { reason: messageOf(error) })
      console.warn('[openrouter-voice] could not register the RPC routes', error)
    }
  })
}

/**
 * Best-effort activation breadcrumb in the plugin's own state file.
 *
 * It is the only externally visible proof of how far the host half got, which
 * matters when a profile change is diagnosed from a terminal. A read-only home
 * must never break activation, so every failure is swallowed.
 * @param stage - short stage name, recorded with its time and optional detail.
 * @param extra - extra fields merged into the state file.
 */
function markStage(stage, extra = {}) {
  try {
    writeState({ hostVersion: VERSION, [stage]: new Date().toISOString(), ...extra })
  } catch (error) {
    console.warn(`[openrouter-voice] could not record stage ${stage}`, error)
  }
}

// Module-evaluation breadcrumb: with `applied`, `injected` and `registered`
// beside it, the state file shows exactly how far the host half got after a
// profile change, without asking anyone to read a process console.
markStage('imported')

