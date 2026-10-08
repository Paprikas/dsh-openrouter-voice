/**
 * Live check: one real recording through OpenRouter, using the credential the
 * harness stores in `$DSH_HOME/.credentials.yaml`.
 *
 * It costs a fraction of a cent and needs the network, so it stays out of
 * `pnpm test`:
 *
 * ```sh
 * say -o /tmp/voice.aiff 'DeepSeek Harness OpenRouter voice check.'
 * afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/voice.aiff /tmp/voice.wav
 * node test/live.mjs /tmp/voice.wav
 * ```
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const recording = process.argv[2]
if (recording === void 0) throw new Error('usage: node test/live.mjs <16 kHz mono PCM16 wav>')

// The key comes from the real harness home; the run's own state stays in a
// throwaway home so a check never rewrites the user's selection.
const realHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const stored = readFileSync(join(realHome, '.credentials.yaml'), 'utf8')
const key = /^\s*OPENROUTER_API_KEY:\s*(\S+)\s*$/m.exec(stored)?.[1]
if (key === void 0) throw new Error(`no OPENROUTER_API_KEY in ${join(realHome, '.credentials.yaml')}`)
const sandbox = mkdtempSync(join(tmpdir(), 'openrouter-voice-live-'))
process.env.DSH_HOME = sandbox

const plugin = await import('../lib/index.js')
const credentials = { resolve: async () => ({ value: key }) }
const routes = new Map()
plugin.apply({
  get: (service) => (service === 'credentials' ? credentials : void 0),
  inject: (services, callback) =>
    callback({
      get: (service) => (service === 'credentials' ? credentials : void 0),
      connection: {
        fetch: {
          register(route) {
            routes.set(route.path, route)
            return () => {}
          },
        },
      },
      effect: () => {},
    }),
}, process.argv[3] === void 0 ? void 0 : { model: process.argv[3] })

/**
 * Drive one endpoint exactly like the browser carrier does.
 * @param endpoint - bare endpoint name.
 * @param payload - endpoint payload.
 * @returns the plugin envelope.
 */
async function handler(endpoint, payload) {
  const path = `/api/openrouter-voice/${endpoint}`
  const request = new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'live', method: `openrouter-voice/${endpoint}`, payload }),
  })
  return (await (await routes.get(path).fetch(request)).json()).result
}

const audio = readFileSync(recording)
const started = Date.now()
const result = await handler('transcribe', { audioBase64: audio.toString('base64'), language: 'en' })
console.log(`round trip: ${Date.now() - started} ms`)
console.log(JSON.stringify(result, null, 2))
if (result.ok !== true) process.exitCode = 1

const catalog = await handler('models', { force: true })
console.log(`transcription models: ${catalog.value.models.length}`)
console.log(catalog.value.models.map((entry) => entry.id).join('\n'))

rmSync(sandbox, { recursive: true, force: true })
