/**
 * Host-half checks: registration, the channel protocol, the catalog, the state
 * file, WAV validation and the OpenRouter request the plugin assembles.
 *
 * The module is imported with a temporary DSH_HOME so the state file never
 * touches the real harness home, and `globalThis.fetch` is stubbed so no
 * request leaves the machine.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeWave } from './wav.mjs'

const home = mkdtempSync(join(tmpdir(), 'openrouter-voice-'))
process.env.DSH_HOME = home

const plugin = await import('../lib/index.js')
const { apply, Config, inject, name } = plugin

assert.equal(name, 'openrouter-voice', 'the plugin id matches the bundle patch id')
assert.deepEqual(inject, ['connection'], 'only the Connection carrier is required')
assert.equal(Config, void 0, 'the host module ships no lazy schema: it must import without top-level await')

/**
 * Mount the host half against the harness services it asks for, and expose the
 * registered routes as a plain `handler(endpoint, payload)` for the checks.
 */
function mount({ credentials, rowConfig } = {}) {
  const routes = new Map()
  const disposers = []
  const connection = {
    // `fetch` is a sibling of `rpc` on the carrier service.
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return () => {
          routes.delete(route.path)
        }
      },
    },
  }
  const ctx = {
    get: (service) => (service === 'credentials' ? credentials : void 0),
    inject(services, callback) {
      assert.deepEqual(services, ['connection'], 'the plugin injects the carrier')
      const inner = {
        // An inject scope still resolves every inherited service.
        get: ctx.get,
        connection,
        effect: (run) => {
          disposers.push(run())
        },
      }
      callback(inner)
      return inner
    },
  }
  apply(ctx, rowConfig)
  assert.equal(routes.size, 5, 'one exact Fetch route per endpoint')
  assert.deepEqual(
    [...routes.keys()].sort(),
    ['config', 'models', 'reset-model', 'set-model', 'transcribe'].map((endpoint) => `/api/openrouter-voice/${endpoint}`),
    'every route sits under the shared /api channel',
  )
  for (const route of routes.values()) {
    assert.deepEqual(route.methods, ['POST'], 'routes accept POST only')
    assert.equal(route.requestBody, 'buffered', 'routes read one buffered JSON body')
  }
  const handler = async (endpoint, payload, signal) => {
    const route = routes.get(`/api/openrouter-voice/${endpoint}`)
    if (route === undefined) throw new Error(`no route for ${endpoint}`)
    const request = new Request(`http://127.0.0.1:19387/api/openrouter-voice/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method: `openrouter-voice/${endpoint}`, payload }),
      signal,
    })
    return (await (await route.fetch(request)).json()).result
  }
  return { handler, routes, disposers, credentials }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** @returns a Response-like object for the stubbed fetch. */
function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  }
}

/** Run one endpoint with a stub fetch and report both the result and the calls. */
async function call(handler, endpoint, payload, { credentials, fetchImpl } = {}) {
  const calls = []
  const previous = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    return fetchImpl === void 0 ? jsonResponse(200, {}) : fetchImpl(String(url), options, calls.length)
  }
  try {
    const result = await handler(endpoint, payload)
    return { result, calls }
  } finally {
    globalThis.fetch = previous
  }
}

// --- the credential seam -----------------------------------------------------

{
  const { handler } = mount({ credentials: { resolve: async () => void 0 } })
  const { result } = await call(handler, 'config', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.hasKey, false, 'a missing credential is reported, not thrown')
  assert.equal(result.value.model, 'google/gemini-3.5-transcribe', 'the committed default model applies')
  assert.equal(result.value.statePath, join(home, 'openrouter-voice.json'))
}

{
  const { handler } = mount({ credentials: { resolve: async (ref) => ({ value: ref === 'TEST_KEY' ? 'sk-or-secret' : void 0 }) }, rowConfig: { apiKeyRef: 'TEST_KEY' } })
  const { result } = await call(handler, 'config', {})
  assert.equal(result.value.hasKey, true, 'the credentials service resolves the row reference')
  assert.equal(result.value.apiKeyRef, 'TEST_KEY')
}

{
  const { handler } = mount()
  process.env.OPENROUTER_API_KEY = 'sk-or-env'
  const { result } = await call(handler, 'config', {})
  assert.equal(result.value.hasKey, true, 'the environment variable is the fallback credential source')
  delete process.env.OPENROUTER_API_KEY
}

// --- activation breadcrumb and envelope framing ------------------------------

{
  const state = JSON.parse(readFileSync(join(home, 'openrouter-voice.json'), 'utf8'))
  assert.equal(state.hostVersion, '0.2.0', 'activation records the host version')
  for (const stage of ['imported', 'applied', 'injected', 'registered']) {
    assert.equal(typeof state[stage], 'string', `the ${stage} stage is recorded`)
  }
  assert.equal(state.routes, 5, 'the registered route count is recorded')
  assert.equal(state.base, '/api/openrouter-voice', 'the registered route base is recorded')
}

{
  // The carrier's exact framing: one malformed body, one mismatched method.
  const { routes } = mount()
  const route = routes.get('/api/openrouter-voice/config')

  const notJson = await route.fetch(new Request('http://127.0.0.1/api/openrouter-voice/config', { method: 'POST', body: 'nope' }))
  assert.equal(notJson.status, 400, 'a non-JSON body is refused')

  const badEnvelope = await route.fetch(new Request('http://127.0.0.1/api/openrouter-voice/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'nonsense' }),
  }))
  assert.equal(badEnvelope.status, 400, 'a body that is not a client-request is refused')

  const mismatch = await route.fetch(new Request('http://127.0.0.1/api/openrouter-voice/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'openrouter-voice/models', payload: {} }),
  }))
  const framed = await mismatch.json()
  assert.equal(framed.type, 'server-response', 'every answer is a server-response')
  assert.equal(framed.rpcId, 'rpc-1', 'the answer echoes the correlation id')
  assert.equal(framed.result.ok, false)
  assert.equal(framed.result.error.code, 'bad-request', 'a method/endpoint mismatch is reported, not served')
  assert.deepEqual(framed.result.error.details, {}, 'the failure carries the details object the carrier requires')
}

// --- the model catalog -------------------------------------------------------

{
  const { handler } = mount()
  const catalog = {
    data: [
      { id: 'openai/whisper-1', name: 'OpenAI: Whisper 1', pricing: { prompt: '0.0001' } },
      { id: 'google/gemini-3.5-transcribe', name: 'Google: Gemini 3.5 Transcribe', context_length: 98304, pricing: {} },
      { id: '', name: 'dropped' },
      'not-a-row',
    ],
  }
  const { result, calls } = await call(handler, 'models', {}, { fetchImpl: () => jsonResponse(200, catalog) })
  assert.equal(result.ok, true)
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/models?output_modalities=transcription', 'the catalog asks for transcription models only')
  assert.deepEqual(result.value.models.map((entry) => entry.id), ['google/gemini-3.5-transcribe', 'openai/whisper-1'], 'rows sort by id and malformed rows drop out')
  assert.equal(result.value.models[0].contextLength, 98304)

  const second = await call(handler, 'models', {}, { fetchImpl: () => jsonResponse(200, catalog) })
  assert.equal(second.calls.length, 0, 'the catalog is cached between calls')
  assert.equal(second.result.value.cached, true)

  const forced = await call(handler, 'models', { force: true }, { fetchImpl: () => jsonResponse(200, catalog) })
  assert.equal(forced.calls.length, 1, 'force bypasses the cache')

  const failed = await call(handler, 'models', { force: true }, { fetchImpl: () => jsonResponse(503, {}) })
  assert.equal(failed.result.ok, false)
  assert.equal(failed.result.error.code, 'catalog-failed')
}

// --- the persisted selection -------------------------------------------------

{
  const { handler } = mount()
  const saved = await call(handler, 'set-model', { model: 'openai/gpt-4o-transcribe' })
  assert.equal(saved.result.ok, true)
  assert.equal(saved.result.value.model, 'openai/gpt-4o-transcribe')
  assert.equal(JSON.parse(readFileSync(join(home, 'openrouter-voice.json'), 'utf8')).model, 'openai/gpt-4o-transcribe')

  const reloaded = mount()
  const after = await call(reloaded.handler, 'config', {})
  assert.equal(after.result.value.model, 'openai/gpt-4o-transcribe', 'the stored selection outlives a remount')

  const reset = await call(reloaded.handler, 'reset-model', {})
  assert.equal(reset.result.value.model, 'google/gemini-3.5-transcribe')

  const blank = await call(reloaded.handler, 'set-model', { model: '   ' })
  assert.equal(blank.result.ok, false)
  assert.equal(blank.result.error.code, 'invalid-request')
}

// --- transcription -----------------------------------------------------------

const samples = new Float32Array(16_000)
for (let index = 0; index < samples.length; index++) samples[index] = Math.sin(index / 40) * 0.4
const wave = encodeWave(samples)
const audioBase64 = wave.toString('base64')

{
  const { handler } = mount({ credentials: { resolve: async () => ({ value: 'sk-or-secret' }) } })
  const { result, calls } = await call(handler, 'transcribe', { audioBase64, language: 'ru' }, {
    fetchImpl: () => jsonResponse(200, { text: '  привет мир  ' }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.text, 'привет мир', 'the transcript is trimmed')
  assert.equal(Math.round(result.value.audioSeconds), 1)
  assert.equal(result.value.model, 'google/gemini-3.5-transcribe')
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/audio/transcriptions')
  assert.equal(calls[0].options.headers.authorization, 'Bearer sk-or-secret', 'the key travels in the authorization header only')
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.model, 'google/gemini-3.5-transcribe')
  assert.equal(body.language, 'ru')
  assert.equal(body.input_audio.format, 'wav')
  assert.equal(body.input_audio.data, audioBase64)
}

{
  const { handler } = mount({ credentials: { resolve: async () => ({ value: 'sk-or-secret' }) } })
  const { result, calls } = await call(handler, 'transcribe', { audioBase64 }, {
    fetchImpl: () => jsonResponse(200, { text: 'ok' }),
  })
  assert.equal(JSON.parse(calls[0].options.body).language, void 0, 'auto detection omits the language field')
}

{
  const { handler } = mount({ credentials: { resolve: async () => ({ value: 'sk-or-secret' }) } })
  const failed = await call(handler, 'transcribe', { audioBase64 }, {
    fetchImpl: () => jsonResponse(402, { error: { message: 'insufficient credits' } }),
  })
  assert.equal(failed.result.ok, false)
  assert.equal(failed.result.error.code, 'provider-failed')
  assert.match(failed.result.error.message, /HTTP 402\): insufficient credits/)
}

{
  const { handler } = mount()
  const missing = await call(handler, 'transcribe', { audioBase64 })
  assert.equal(missing.result.ok, false)
  assert.equal(missing.result.error.code, 'missing-credential', 'a missing key fails before any request is assembled')
  assert.equal(missing.calls.length, 0)
}

{
  const { handler } = mount({ credentials: { resolve: async () => ({ value: 'sk-or-secret' }) } })
  const empty = await call(handler, 'transcribe', {})
  assert.equal(empty.result.error.code, 'invalid-audio')

  const notAudio = await call(handler, 'transcribe', { audioBase64: Buffer.from('hello there, not a wave at all').toString('base64') })
  assert.equal(notAudio.result.error.code, 'invalid-audio')

  const truncated = await call(handler, 'transcribe', { audioBase64: Buffer.from('RIFF....WAVE').toString('base64') })
  assert.equal(truncated.result.error.code, 'invalid-audio')

  const float = Buffer.from(wave)
  float.writeUInt16LE(3, 20)
  assert.equal((await call(handler, 'transcribe', { audioBase64: float.toString('base64') })).result.error.code, 'invalid-audio')

  const long = encodeWave(new Float32Array(16_000 * 400))
  const tooLong = await call(handler, 'transcribe', { audioBase64: long.toString('base64') })
  assert.equal(tooLong.result.error.code, 'too-long')

  const odd = `${audioBase64.slice(0, -2)}!!`
  assert.equal((await call(handler, 'transcribe', { audioBase64: odd })).result.error.code, 'invalid-audio', 'non-canonical base64 is refused')
}

// --- surface and teardown ----------------------------------------------------

{
  const { routes, disposers } = mount()
  // Exact routes mean there is no catch-all: the browser can only reach the
  // five endpoints this plugin owns.
  assert.equal(routes.has('/api/openrouter-voice/nonsense'), false, 'no route is registered for an unknown endpoint')
  assert.equal(routes.size, 5)
  for (const dispose of disposers) await dispose()
  for (const dispose of disposers) assert.equal(typeof dispose, 'function', 'every route hands back a disposer')
}

rmSync(home, { recursive: true, force: true })
console.log('openrouter-voice host checks passed')
