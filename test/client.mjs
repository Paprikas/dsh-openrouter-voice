/**
 * Browser-half checks.
 *
 * `lib/client.js` is a loader bundle, not an ES module: it hands a factory to
 * `window.__ModuleLoader__`. This harness runs that bundle against a fake
 * loader and materializes it with the real React and the real DSH primitives,
 * so the shipped code (not a copy of it) is what gets tested. jsdom supplies
 * the DOM; the microphone stack is faked deterministically.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)

/** Install jsdom plus the browser audio stack on the Node globals. */
function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:19387/' })
  const { window } = dom
  const tracks = [{ stopped: 0, stop() { this.stopped++ } }]
  const stream = { getTracks: () => tracks }
  let denied = false

  class FakeMediaRecorder {
    static instances = []
    constructor() {
      this.state = 'inactive'
      this.mimeType = 'audio/webm'
      this.ondataavailable = null
      this.onstop = null
      this.onerror = null
      FakeMediaRecorder.instances.push(this)
    }
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data: new window.Blob([new Uint8Array(4096)], { type: this.mimeType }) })
      this.onstop?.()
    }
  }

  class FakeAnalyser {
    constructor() {
      this.fftSize = 256
      this.samples = new Float32Array(256)
    }
    getFloatTimeDomainData(target) { target.fill(0.2) }
  }

  class FakeAudioContext {
    constructor() { this.state = 'running' }
    createAnalyser() { return new FakeAnalyser() }
    createMediaStreamSource() { return { connect() {} } }
    async decodeAudioData() { return { duration: 0.5 } }
    async close() { this.state = 'closed' }
  }

  class FakeOfflineAudioContext {
    constructor(channels, length, rate) {
      this.length = length
      this.rate = rate
      this.destination = {}
    }
    createBufferSource() { return { buffer: null, connect() {}, start() {} } }
    async startRendering() { return { getChannelData: () => new Float32Array(this.length) } }
  }

  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => {
        if (denied) throw new window.DOMException('denied', 'NotAllowedError')
        return stream
      },
    },
  })

  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    DOMException: window.DOMException,
    Blob: window.Blob,
    MediaRecorder: FakeMediaRecorder,
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeOfflineAudioContext,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  window.AudioContext = FakeAudioContext
  window.OfflineAudioContext = FakeOfflineAudioContext
  window.MediaRecorder = FakeMediaRecorder
  globalThis.btoa = (text) => Buffer.from(text, 'binary').toString('base64')
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  return {
    window,
    FakeMediaRecorder,
    tracks,
    stream,
    setDenied: (value) => { denied = value },
  }
}

/** Evaluate the client bundle and materialize its factory. */
async function loadClient() {
  const primitives = await import('@deepseek-ai/dsh-client-ui-primitives')
  const table = new Map()
  globalThis.window.__ModuleLoader__ = { load: (descriptor) => table.set(descriptor.id, descriptor) }
  await import('../lib/client.js')
  const descriptor = table.get('dsh-openrouter-voice')
  assert.ok(descriptor, 'the bundle registers its module id')
  const exports = descriptor.factory((id) => {
    if (id === 'react') return require('react')
    if (id === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected client require: ${id}`)
  })
  return { exports, descriptor }
}

/**
 * A client runtime stub that still enforces the real slot contracts through
 * `SlotCore`, plus a Connection stub recording every channel call.
 * @param answers - endpoint name to `{ ok, value }` / `{ ok, error }` answer.
 */
async function mockContext(answers) {
  const { SlotCore } = await import('@deepseek-ai/dsh-client-ui-slots')
  const registrations = []
  const locales = []
  const effects = []
  const calls = []
  const created = []
  const opened = []
  const sessionWatchers = new Map()
  const removed = new Set()
  const inputs = new Map()
  const emptyInput = { state: { getSnapshot: () => ({ draft: '', draftRev: 0, phase: 'plain', attachmentIds: [] }) }, setDraft() {}, removeAttachment() { return false }, commitSend() {} }
  // The Session list and workspace rows the reuse rule reads: by default one
  // workspace holding one blank Session, the shape a fresh "New chat" has.
  const list = answers.list ?? {
    ids: ['session-1'],
    byId: { 'session-1': { id: 'session-1', blank: true, cwd: '/tmp/project' } },
  }
  const workspaces = answers.workspaces === undefined
    ? { items: [{ workspaceId: 'ws-1', path: '/tmp/project', sessionIds: list.ids }] }
    : answers.workspaces
  const core = new SlotCore()
  core.register({ name: 'root', scope: 'root', children: {
    'main.conversation': { kind: 'single', scope: 'session-maybe' },
    'settings.section': { kind: 'list', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
  } }, () => null)
  core.register({ name: 'main.conversation', scope: 'session-maybe', children: {
    'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
  } }, () => null)
  core.register({ name: 'conversation.composer.bar', scope: 'session-maybe', children: {
    // The seat is the compact action right after the model selector.
    'conversation.input.activity': { kind: 'single', scope: 'session' },
  } }, () => null)
  core.register({ name: 'settings.section', id: 'general', scope: 'root', children: {
    'settings.general.item': { kind: 'list', scope: 'root' },
  } }, () => null)

  return {
    registrations,
    locales,
    effects,
    calls,
    created,
    opened,
    setInput(sessionId, input) { inputs.set(sessionId, input) },
    conversation: {
      input: { for: (scope) => inputs.get(scope.sessionId) ?? emptyInput },
      async sendSession(session, text, attachmentIds, mode, signal) {
        calls.push({ sessionId: session.ctx?.sessionId ?? session.sessionId, sendSession: true, text, attachmentIds, mode, signal })
        if (answers.sendSession) return answers.sendSession({ session, text, attachmentIds, mode, signal })
        const content = [
          ...attachmentIds.map((id) => ({ type: 'attachment', id })),
          ...(text === '' ? [] : [{ type: 'text', text }]),
        ]
        const receipt = await session.prompt(content, mode, signal)
        return receipt.ok ? { kind: 'success' } : { kind: 'error', text: receipt.error?.message }
      },
    },
    removeSession(sessionId) {
      removed.add(sessionId)
      delete list.byId[sessionId]
      for (const listener of [...(sessionWatchers.get(sessionId) ?? [])]) listener()
    },
    core,
    get(name) {
      if (name === 'uiWorkspace') return { openSession: (id) => opened.push(id) }
      if (name === 'workspaces' && workspaces !== null) return { list: { getSnapshot: () => workspaces } }
      return void 0
    },
    effect(callback) {
      const disposer = callback()
      effects.push(disposer)
      return disposer
    },
    slots: {
      inject(name, factory) {
        const result = factory()
        registrations.push({ slot: name, ...result })
        return result
      },
      register(descriptor, Component) {
        const dispose = core.register(descriptor, Component)
        return { descriptor, Component, dispose }
      },
    },
    locale: {
      register(ns, dictionaries) {
        locales.push({ ns, dictionaries })
        return () => {}
      },
    },
    sessions: {
      list: { getSnapshot: () => list },
      async create(options) {
        created.push(options)
        return 'session-next'
      },
      retain(sessionId, options) {
        const lease = { sessionId, released: false }
        calls.push({ lease, options })
        return {
          ready: Promise.resolve({ ctx: { sessionId }, session: {
            sessionId,
            getSnapshot: () => ({ removed: removed.has(sessionId) }),
            subscribe(listener) {
              if (!sessionWatchers.has(sessionId)) sessionWatchers.set(sessionId, new Set())
              sessionWatchers.get(sessionId).add(listener)
              return () => sessionWatchers.get(sessionId).delete(listener)
            },
            async prompt(content, mode, signal) {
              assert.equal(lease.released, false, 'origin remains retained until host acknowledgement')
              calls.push({ sessionId, content, mode, signal })
              return answers.prompt ? answers.prompt(content) : { ok: true, value: { accepted: true } }
            },
          } }),
          release() {
            assert.equal(lease.released, false, 'release exactly once')
            lease.released = true
          },
        }
      },
    },
    connection: {
      isLoopback: true,
      rpc: {
        async call(channel, endpoint, payload, signal) {
          calls.push({ channel, endpoint, payload, signal })
          // The plugin prefixes its endpoint with the route it owns under /api.
          const key = endpoint.startsWith('openrouter-voice/') ? endpoint.slice('openrouter-voice/'.length) : endpoint
          const answer = answers[key]
          if (answer === void 0) return { ok: false, error: { code: 'unknown-endpoint', message: endpoint, details: {} } }
          return typeof answer === 'function' ? answer(payload) : answer
        },
      },
    },
  }
}

/** Mount one component into a fresh jsdom container. */
async function mount(Component, props) {
  const { createRoot } = await import('react-dom/client')
  const react = await import('react')
  const act = typeof react.act === 'function' ? react.act : (await import('react-dom/test-utils')).act
  const container = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(react.createElement(Component, props))
  })
  return {
    container,
    act,
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** @param act - React act. @param element - element with a click handler. */
async function click(act, element) {
  assert.ok(element, 'the clicked element exists')
  await act(async () => {
    element.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/**
 * Settle the async work a click started: the capture pipeline awaits a Blob,
 * an offline render and one RPC round trip, so a single microtask flush is not
 * enough to reach the insert.
 * @param act - React's act.
 */
async function settle(act) {
  for (let round = 0; round < 8; round++) {
    await act(async () => {
      await Promise.resolve()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** @param bytes - WAV bytes. @returns the header fields under test. */
function readWaveHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (offset) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
  return {
    riff: ascii(0),
    wave: ascii(8),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
  }
}

/**
 * Build the activity-slot props, recording inserts and submissions.
 * @param options - `stuck` makes `insertText` refuse, standing in for a composer
 *   whose draft moved on while the transcription was on the wire.
 */
function voiceProps(options = {}) {
  const inserted = []
  const submitted = []
  const activation = []
  const control = { stuck: options.stuck === true, draft: options.draft ?? '', rev: 0, caret: (options.draft ?? '').length, attachments: options.attachments ? [...options.attachments] : [] }
  const edit = (text, caret = text.length) => {
    control.draft = text
    control.caret = caret
    control.rev++
  }
  return {
    edit,
    input: {
      state: { getSnapshot: () => ({ draft: control.draft, draftRev: control.rev, phase: 'plain', attachmentIds: control.attachments }) },
      setDraft: edit,
      removeAttachment: (id) => {
        control.attachments = control.attachments.filter((x) => x !== id)
        return true
      },
      commitSend: (attachmentIds) => {
        const submitted = new Set(attachmentIds)
        control.attachments = control.attachments.filter((x) => !submitted.has(x))
      },
    },
    inserted,
    submitted,
    activation,
    control,
    props: {
      sessionId: 'session-1',
      locked: false,
      onActiveChange: (active) => activation.push(active),
      inputActions: {
        captureInsertion: () => ({ from: control.caret, to: control.caret, draftRev: control.rev }),
        insertText: (text, span) => {
          if (control.stuck || span.draftRev !== control.rev) return false
          inserted.push(text)
          edit(control.draft.slice(0, span.from) + text + control.draft.slice(span.to), span.from + text.length)
          return true
        },
        submit: () => submitted.push(true),
      },
      t: (key) => key,
    },
  }
}

/** Run the suite body with one installed DOM and one loaded bundle. */
async function suite() {
  const dom = installDom()
  const { exports } = await loadClient()

  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['connection', 'slots', 'locale', 'sessions', 'conversation'], 'only stable client services are required')
  assert.equal(exports.internals.NS, 'openrouter-voice')
  assert.equal(exports.internals.API_CHANNEL, '/api', 'browser RPC rides the shared channel')
  assert.equal(exports.internals.ROUTE, 'openrouter-voice', 'the plugin owns one endpoint prefix under /api')

  // `config` and `set-model` mirror the host's `describe()` shape; the
  // set-model echo hands back the saved configuration like the real endpoint.
  const configValue = {
    model: 'google/gemini-3.5-transcribe',
    defaultModel: 'google/gemini-3.5-transcribe',
    language: 'auto',
    apiKeyRef: 'OPENROUTER_API_KEY',
    hasKey: true,
    maxAudioBytes: 8388608,
    maxDurationSeconds: 180,
    models: [],
    modelsFetchedAt: null,
    statePath: '/tmp/dsh-home/openrouter-voice.json',
  }
  const answers = {
    config: { ok: true, value: configValue },
    models: { ok: true, value: { models: [
      { id: 'openai/whisper-1', name: 'Whisper 1' },
      { id: 'google/gemini-3.5-transcribe', name: 'Gemini 3.5 Transcribe' },
    ], fetchedAt: 1, cached: false } },
    'set-model': (payload) => ({ ok: true, value: { ...configValue, model: payload.model } }),
    transcribe: { ok: true, value: { text: 'hello world', audioSeconds: 0.5, inferenceSeconds: 0.2, model: 'google/gemini-3.5-transcribe' } },
  }

  // --- registration --------------------------------------------------------

  const ctx = await mockContext(answers)
  const dispose = exports.apply(ctx)
  assert.deepEqual(
    ctx.registrations.map((entry) => entry.slot).sort(),
    ['conversation.input.activity', 'plugins.bundle.config'],
    'the control takes the activity seat after the model selector, and the row takes the plugin config seat',
  )
  assert.equal(ctx.locales.length, 1, 'dictionaries register once')
  assert.ok(ctx.locales[0].dictionaries.ru, 'Russian copy ships with the bundle')

  const mic = ctx.registrations.find((entry) => entry.slot === 'conversation.input.activity')
  assert.equal(ctx.registrations.some((entry) => entry.slot === 'settings.general.item'), false, 'no model row registers in General settings')
  const row = ctx.registrations.find((entry) => entry.slot === 'plugins.bundle.config')
  assert.deepEqual(row.descriptor, {
    name: 'plugins.bundle.config', key: 'dsh-openrouter-voice', locale: 'openrouter-voice',
  }, 'the model row uses the exact package key and unchanged locale, without id or order')

  // --- collapsed trigger ---------------------------------------------------

  const voice = voiceProps({ draft: 'typed ' })
  ctx.setInput('session-1', voice.input)
  const view = await mount(mic.Component, voice.props)
  const trigger = view.container.querySelector('button')
  assert.ok(trigger, 'the collapsed microphone trigger renders')
  assert.equal(trigger.getAttribute('aria-label'), 'start', 'the trigger carries the stock accessible name')
  assert.equal(trigger.querySelector('svg') !== null, true, 'the trigger uses the stock microphone icon')
  assert.equal(view.container.querySelector('[data-voice-activity]'), null, 'nothing expands before a recording')

  // --- record and stop: insert without submitting ---------------------------

  await click(view.act, trigger)
  await settle(view.act)
  const rowElement = view.container.querySelector('[data-voice-activity]')
  assert.ok(rowElement, 'the capture row replaces the trigger while active')
  assert.equal(rowElement.getAttribute('data-voice-activity'), 'recording')
  assert.ok(rowElement.querySelector('svg.ovo_waveform'), 'the stock waveform renders while recording')
  assert.ok(rowElement.querySelector('button[aria-label="stop"]'), 'the stop button renders')
  assert.ok(rowElement.querySelector('button[aria-label="start.send"]'), 'the instant send button renders next to stop')
  assert.equal(voice.activation.at(-1), true, 'the composer is told to expand')

  const recorder = dom.FakeMediaRecorder.instances.at(-1)
  assert.equal(recorder.state, 'recording')

  await click(view.act, view.container.querySelector('button[aria-label="stop"]'))
  await settle(view.act)
  const call = ctx.calls.find((entry) => entry.endpoint === 'openrouter-voice/transcribe')
  assert.ok(call, 'the recording reached the host channel')
  assert.equal(call.channel, '/api', 'the call rides the shared /api channel')
  assert.equal(call.endpoint, 'openrouter-voice/transcribe', 'the endpoint names the plugin route')
  assert.equal(recorder.state, 'inactive', 'the recorder stopped')
  // The shipped recorder releases the tracks on stop and again on dispose, so
  // the assertion is "released", not "released exactly once".
  assert.ok(dom.tracks[0].stopped >= 1, 'the microphone track was released')
  const header = readWaveHeader(new Uint8Array(Buffer.from(call.payload.audioBase64, 'base64')))
  assert.deepEqual(
    { riff: header.riff, wave: header.wave, channels: header.channels, sampleRate: header.sampleRate, bits: header.bits },
    { riff: 'RIFF', wave: 'WAVE', channels: 1, sampleRate: 16000, bits: 16 },
    'the host receives a canonical 16 kHz mono PCM16 WAV',
  )
  assert.equal(header.dataBytes, 16000, 'resampling produced 0.5 s of 16 kHz samples')
  assert.deepEqual(voice.inserted, ['hello world'], 'the transcript is inserted through inputActions')
  assert.equal(voice.control.draft, 'typed hello world', 'plain stop adds to a preexisting draft without a warning')
  assert.deepEqual(voice.submitted, [], 'the plain stop button only inserts')
  assert.equal(view.container.querySelector('[data-voice-activity]'), null, 'the control collapses after a successful insert')

  // --- record and send: insert then submit ---------------------------------

  await click(view.act, view.container.querySelector('button'))
  await settle(view.act)
  assert.equal(view.container.querySelector('[data-voice-activity]').getAttribute('data-voice-activity'), 'recording')
  await click(view.act, view.container.querySelector('button[aria-label="start.send"]'))
  await settle(view.act)
  assert.deepEqual(voice.inserted, ['hello world'], 'direct send combines text without a redundant editor insert')
  assert.deepEqual(voice.submitted, [], 'direct send never uses composer submit')
  assert.deepEqual(ctx.calls.filter(c => c.content).map(c => [c.sessionId, c.content, c.mode]), [
    ['session-1', [{ type: 'text', text: 'typed hello world\nhello world' }], 'queue'],
  ])
  assert.equal(voice.control.draft, '', 'an acknowledged combined send clears the sent origin text')
  assert.ok(ctx.calls.filter(c => c.lease).every(c => c.lease.released), 'completed operations release their sessions')
  assert.equal(view.container.querySelector('[data-voice-activity]'), null, 'the control collapses after sending')

  await view.unmount()

  // --- record and send with attached files ---------------------------------

  const attachVoice = voiceProps({ draft: '', attachments: ['attachment-file-1', 'attachment-file-2'] })
  ctx.setInput('session-1', attachVoice.input)
  const attachView = await mount(mic.Component, attachVoice.props)
  await click(attachView.act, attachView.container.querySelector('button'))
  await settle(attachView.act)
  assert.equal(attachView.container.querySelector('[data-voice-activity]').getAttribute('data-voice-activity'), 'recording')
  await click(attachView.act, attachView.container.querySelector('button[aria-label="start.send"]'))
  await settle(attachView.act)

  const sendSessionCall = ctx.calls.find((c) => c.sendSession === true && c.sessionId === 'session-1')
  assert.ok(sendSessionCall, 'the conversation.sendSession was invoked for draft with attachments')
  assert.equal(sendSessionCall.text, 'hello world', 'voice transcript is passed as prompt text')
  assert.deepEqual(sendSessionCall.attachmentIds, ['attachment-file-1', 'attachment-file-2'], 'attachments are attached to the send')
  assert.equal(sendSessionCall.mode, 'queue')
  assert.deepEqual(attachVoice.control.attachments, [], 'sent attachments are cleared from composer draft after send')
  assert.equal(attachVoice.control.draft, '', 'draft is cleared')
  assert.equal(attachView.container.querySelector('[data-voice-activity]'), null, 'the control collapses after send')
  await attachView.unmount()

  // --- the recording outlives focus ------------------------------------------

  const focusVoice = voiceProps()
  const focusView = await mount(mic.Component, focusVoice.props)
  await click(focusView.act, focusView.container.querySelector('button'))
  await settle(focusView.act)
  assert.equal(focusView.container.querySelector('[data-voice-activity]').getAttribute('data-voice-activity'), 'recording')
  const focusRecorder = dom.FakeMediaRecorder.instances.at(-1)
  const releasedBefore = dom.tracks[0].stopped

  // `document.hidden` is a prototype getter, so an own property stands in for a
  // background tab; the point of the check is that the bundle ignores the event.
  Object.defineProperty(globalThis.document, 'hidden', { configurable: true, get: () => true })
  await focusView.act(async () => {
    globalThis.window.dispatchEvent(new globalThis.window.Event('blur'))
    globalThis.document.dispatchEvent(new globalThis.window.Event('visibilitychange'))
  })
  assert.equal(
    focusView.container.querySelector('[data-voice-activity]').getAttribute('data-voice-activity'),
    'recording',
    'losing window focus or hiding the tab leaves the capture running',
  )
  assert.equal(focusRecorder.state, 'recording', 'the recorder keeps encoding in the background')
  assert.equal(dom.tracks[0].stopped, releasedBefore, 'the microphone track is not released while backgrounded')
  delete globalThis.document.hidden

  // Escape is still the way out, and it still cancels.
  await focusView.act(async () => {
    globalThis.document.dispatchEvent(new globalThis.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  assert.equal(focusView.container.querySelector('[data-voice-activity]'), null, 'Escape cancels a background recording')
  assert.ok(dom.tracks[0].stopped > releasedBefore, 'Escape releases the microphone')

  // And a recording that returns to the front still transcribes and inserts.
  await click(focusView.act, focusView.container.querySelector('button'))
  await settle(focusView.act)
  Object.defineProperty(globalThis.document, 'hidden', { configurable: true, get: () => true })
  await focusView.act(async () => {
    globalThis.window.dispatchEvent(new globalThis.window.Event('blur'))
    globalThis.document.dispatchEvent(new globalThis.window.Event('visibilitychange'))
  })
  delete globalThis.document.hidden
  await click(focusView.act, focusView.container.querySelector('button[aria-label="stop"]'))
  await settle(focusView.act)
  assert.deepEqual(focusVoice.inserted, ['hello world'], 'a backgrounded recording still transcribes and inserts')
  await focusView.unmount()

  // --- transcription model row ---------------------------------------------
  // The row mounts on the plugin bundle page. Catalog mode shows the select
  // only; the "Custom ID…" option (value "") swaps it for a standalone
  // free-text field, and save/refresh are separate labeled buttons.

  // The row receives its translator through props; parameters surface in the
  // rendered note, which makes the stored model observable.
  const rowProps = { t: (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`) }
  /** Pick one select option the way a user would. */
  const chooseOption = async (view, select, value) => {
    await view.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(globalThis.window.HTMLSelectElement.prototype, 'value').set
      setter.call(select, value)
      select.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
    })
  }
  /** Type into the custom id field the way a user would. */
  const typeModelId = async (view, input, text) => {
    await view.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value').set
      setter.call(input, text)
      input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
    })
  }

  const rowView = await mount(row.Component, rowProps)
  await settle(rowView.act)
  const select = rowView.container.querySelector('select')
  assert.ok(select, 'the model select renders')
  assert.deepEqual(
    [...select.options].map((option) => option.value),
    ['', 'openai/whisper-1', 'google/gemini-3.5-transcribe'],
    'the custom option leads the plain catalog options',
  )
  assert.equal(select.value, 'google/gemini-3.5-transcribe', 'the select follows the unsaved draft')
  assert.equal(select.disabled, false, 'a loaded config enables the select')
  assert.equal(rowView.container.querySelector('input'), null, 'catalog mode renders no custom input')
  assert.equal(rowView.container.querySelectorAll('label').length, 1, 'catalog mode renders the select row only')
  assert.match(rowView.container.textContent, /model\.current \{"model":"google\/gemini-3\.5-transcribe"\}/)

  const actions = rowView.container.querySelector('.ovo_modelActions')
  assert.ok(actions, 'the actions row renders')
  const rowButtons = [...actions.querySelectorAll('button')]
  assert.deepEqual(rowButtons.map((button) => button.textContent), ['model.save', 'model.refresh'], 'save and refresh are separate labeled buttons')
  assert.equal(rowButtons[1].querySelector('svg'), null, 'the refresh button carries text, not an icon')
  assert.equal(rowButtons[0].disabled, true, 'an untouched row cannot save')
  assert.equal(rowButtons[1].disabled, false, 'a loaded config enables the refresh')
  const saveButton = rowButtons[0]
  const refreshButton = rowButtons[1]

  // Choosing the custom option clears the draft and reveals the standalone field.
  await chooseOption(rowView, select, '')
  const customLabel = rowView.container.querySelectorAll('label')[1]
  const customField = rowView.container.querySelector('.ovo_inlineGrow')
  const input = customField === null ? null : customField.querySelector('input')
  assert.ok(input, 'custom mode renders the id field')
  assert.equal(customLabel.textContent.includes('model.custom'), true, 'the custom field keeps its label')
  assert.equal(input.value, '', 'choosing the custom option clears the unsaved draft')
  assert.equal(select.value, '', 'the select shows the custom option in custom mode')
  assert.equal(customField.tagName, 'SPAN', 'the custom field is a standalone wide block, not an inline group')
  assert.equal(globalThis.window.getComputedStyle(customField).width, '100%', 'the custom field takes the full row width')
  assert.equal(customLabel.querySelectorAll('button').length, 0, 'no save or refresh buttons sit inside the custom field')
  assert.equal(rowView.container.querySelector('.ovo_inline'), null, 'the old inline save/refresh group is gone')
  assert.equal(input.getAttribute('aria-label'), 'model.custom')
  assert.equal(input.getAttribute('placeholder'), 'provider/model-id')
  assert.equal(saveButton.disabled, true, 'an empty draft cannot save')

  // A typed custom id never leaks the default Google model into the select.
  await typeModelId(rowView, input, '  openai/gpt-4o-transcribe  ')
  assert.equal(input.value, '  openai/gpt-4o-transcribe  ')
  assert.equal(select.value, '', 'a typed custom id keeps the select on the custom option, not the default Google model')
  assert.equal(saveButton.disabled, false, 'a non-empty draft enables saving')

  await click(rowView.act, saveButton)
  await settle(rowView.act)
  const saved = ctx.calls.filter((entry) => entry.endpoint === 'openrouter-voice/set-model').pop()
  assert.ok(saved, 'saving reaches the host channel')
  assert.deepEqual(saved.payload, { model: 'openai/gpt-4o-transcribe' }, 'the model id is trimmed before it is saved')
  assert.match(rowView.container.textContent, /model\.current \{"model":"openai\/gpt-4o-transcribe"\}/, 'a successful save persists the new model')
  assert.equal(input.value, 'openai/gpt-4o-transcribe', 'the saved id replaces the untrimmed draft')
  assert.equal(saveButton.disabled, true, 'a persisted row cannot save again')
  assert.equal(saveButton.textContent, 'model.save', 'the saving label reverts after the round trip')

  // Refresh keeps custom mode alive and bypasses the host cache.
  await click(rowView.act, refreshButton)
  await settle(rowView.act)
  assert.equal(rowView.container.querySelector('input'), input, 'refresh preserves custom mode')
  assert.equal(select.value, '', 'refresh keeps the select on the custom option')
  const modelCalls = ctx.calls.filter((entry) => entry.endpoint === 'openrouter-voice/models')
  assert.equal(modelCalls.length, 2, 'the row loads the catalog once and refreshes once')
  assert.deepEqual(modelCalls.at(-1).payload, { force: true }, 'refresh asks the host to bypass the catalog cache')

  // Selecting a catalog entry leaves custom mode; the select follows the still
  // unsaved draft while the note keeps showing the stored model.
  await chooseOption(rowView, select, 'openai/whisper-1')
  assert.equal(select.value, 'openai/whisper-1', 'the select follows the unsaved draft after picking a catalog entry')
  assert.equal(rowView.container.querySelector('input'), null, 'selecting a catalog entry hides the custom input')
  assert.equal(rowView.container.querySelectorAll('label').length, 1, 'catalog mode renders the select row only')
  assert.match(rowView.container.textContent, /model\.current \{"model":"openai\/gpt-4o-transcribe"\}/, 'the note keeps showing the stored model until a save')
  assert.equal(saveButton.disabled, false, 'the catalog draft is savable')

  // The custom draft survives catalogue switches: re-entering custom mode
  // restores the saved custom id instead of the draft of the catalog entry.
  await chooseOption(rowView, select, '')
  assert.equal(rowView.container.querySelector('input').value, 'openai/gpt-4o-transcribe', 'choosing custom again restores the saved custom id')
  assert.equal(select.value, '', 'the select shows the custom option again')

  // An unsaved custom id also survives the round trip through the catalog.
  await typeModelId(rowView, rowView.container.querySelector('input'), 'vendor/custom-long-id')
  await chooseOption(rowView, select, 'openai/whisper-1')
  assert.equal(rowView.container.querySelector('input'), null, 'switching to a catalog entry hides the custom input again')
  await chooseOption(rowView, select, '')
  assert.equal(rowView.container.querySelector('input').value, 'vendor/custom-long-id', 'returning to custom restores the unsaved exact string')
  assert.equal(select.value, '', 'the select stays on the custom option after the round trip')
  await rowView.unmount()

  // --- a loaded id the catalog does not list yet -----------------------------

  const absentCatalog = [{ id: 'openai/whisper-1', name: 'Whisper 1' }]
  const absentRow = await mockContext({
    ...answers,
    models: () => ({ ok: true, value: { models: [...absentCatalog], fetchedAt: 1, cached: false } }),
  })
  exports.apply(absentRow)
  const absentView = await mount(absentRow.registrations.find((entry) => entry.slot === 'plugins.bundle.config').Component, rowProps)
  await settle(absentView.act)
  const absentSelect = absentView.container.querySelector('select')
  assert.deepEqual(
    [...absentSelect.options].map((option) => option.value),
    ['', 'openai/whisper-1'],
    'an unknown loaded id is not injected into the catalog options',
  )
  assert.equal(absentSelect.value, '', 'the row infers custom mode for an unknown loaded id')
  assert.equal(absentView.container.querySelector('input').value, 'google/gemini-3.5-transcribe', 'the loaded custom id fills the standalone field')

  await click(absentView.act, [...absentView.container.querySelectorAll('button')].find((button) => button.textContent === 'model.refresh'))
  await settle(absentView.act)
  assert.equal(absentView.container.querySelector('input')?.value, 'google/gemini-3.5-transcribe', 'refresh preserves inferred custom mode')

  await chooseOption(absentView, absentSelect, 'openai/whisper-1')
  assert.equal(absentSelect.value, 'openai/whisper-1', 'selecting a catalog entry updates the select')
  assert.equal(absentView.container.querySelector('input'), null, 'selecting a catalog entry hides the custom input')

  // The loaded custom id survives switching to the catalog and back.
  await chooseOption(absentView, absentSelect, '')
  assert.equal(absentView.container.querySelector('input').value, 'google/gemini-3.5-transcribe', 'returning to custom restores the loaded custom id')
  await chooseOption(absentView, absentSelect, 'openai/whisper-1')
  assert.equal(absentSelect.value, 'openai/whisper-1', 'the row returns to the catalog draft before the refresh test')

  // A refresh that drops the selected entry must not visually fall back to
  // another model: the select keeps following the unsaved draft.
  absentCatalog.length = 0
  await click(absentView.act, [...absentView.container.querySelectorAll('button')].find((button) => button.textContent === 'model.refresh'))
  await settle(absentView.act)
  assert.equal(absentSelect.value, 'openai/whisper-1', 'the select follows the unsaved draft even when the catalog drops it')
  assert.deepEqual([...absentSelect.options].map((option) => option.value), ['', 'openai/whisper-1'], 'the dropped draft id is injected as a selectable option')
  await absentView.unmount()

  // --- a failed save retains the draft ---------------------------------------

  let resolveFailedSave
  const failedRow = await mockContext({
    ...answers,
    'set-model': () => new Promise((resolve) => { resolveFailedSave = resolve }),
  })
  exports.apply(failedRow)
  const failedView = await mount(failedRow.registrations.find((entry) => entry.slot === 'plugins.bundle.config').Component, rowProps)
  await settle(failedView.act)
  const failedSelect = failedView.container.querySelector('select')
  await chooseOption(failedView, failedSelect, '')
  await typeModelId(failedView, failedView.container.querySelector('input'), 'openai/gpt-4o-mini-transcribe')
  const failedSaveButton = [...failedView.container.querySelectorAll('button')].find((button) => button.textContent === 'model.save')
  await click(failedView.act, failedSaveButton)
  await settle(failedView.act)
  assert.equal(failedSaveButton.textContent, 'model.saving', 'the save button reports the saving state')
  assert.equal(failedSaveButton.disabled, true, 'saving disables the save button')
  assert.equal(failedSelect.disabled, true, 'saving locks the select')
  assert.equal(failedView.container.querySelector('input').disabled, true, 'saving locks the custom field')
  assert.equal(
    [...failedView.container.querySelectorAll('button')].find((button) => button.textContent === 'model.refresh').disabled,
    true,
    'saving locks the refresh button',
  )
  const attempt = failedRow.calls.filter((entry) => entry.endpoint === 'openrouter-voice/set-model').pop()
  assert.deepEqual(attempt.payload, { model: 'openai/gpt-4o-mini-transcribe' })
  resolveFailedSave({ ok: false, error: { code: 'provider-failed', message: 'OpenRouter refused', details: {} } })
  await settle(failedView.act)
  assert.match(failedView.container.textContent, /model\.saveFailed/, 'a failed save names the failure')
  assert.equal(failedView.container.querySelector('input').value, 'openai/gpt-4o-mini-transcribe', 'a failed save retains the typed draft')
  assert.equal(failedSelect.value, '', 'a failed save keeps custom mode')
  assert.equal(failedSaveButton.textContent, 'model.save', 'the saving label reverts after a failure')
  assert.equal(failedSaveButton.disabled, false, 'the retained draft can be retried')
  await failedView.unmount()

  // --- a tab switch tears the control down -----------------------------------

  const tabVoice = voiceProps()
  const tabView = await mount(mic.Component, tabVoice.props)
  await click(tabView.act, tabView.container.querySelector('button'))
  await settle(tabView.act)
  assert.equal(tabView.container.querySelector('[data-voice-activity]').getAttribute('data-voice-activity'), 'recording')

  // The tab switch itself: the control goes away mid-recording.
  await tabView.unmount()
  const backView = await mount(mic.Component, tabVoice.props)
  assert.equal(
    backView.container.querySelector('[data-voice-activity]').getAttribute('data-voice-activity'),
    'recording',
    'the live recording reattaches to the control that comes back',
  )
  await click(backView.act, backView.container.querySelector('button[aria-label="stop"]'))
  await settle(backView.act)
  assert.deepEqual(tabVoice.inserted, ['hello world'], 'a recording that outlived the switch still transcribes')
  assert.equal(backView.container.querySelector('[data-voice-activity]'), null, 'the control collapses again')
  await backView.unmount()

  // --- a tab switch while the transcription is on the wire -------------------

  let release
  const flight = await mockContext({
    ...answers,
    transcribe: () => new Promise((resolve) => { release = resolve }),
  })
  exports.apply(flight)
  const flightMic = flight.registrations.find((entry) => entry.slot === 'conversation.input.activity')
  const flightVoice = voiceProps()
  const flightView = await mount(flightMic.Component, flightVoice.props)
  await click(flightView.act, flightView.container.querySelector('button'))
  await settle(flightView.act)
  await click(flightView.act, flightView.container.querySelector('button[aria-label="start.send"]'))
  await settle(flightView.act)
  assert.equal(
    flightView.container.querySelector('[data-voice-activity]').getAttribute('data-voice-activity'),
    'transcribing',
    'the send gesture reports the transcription in flight',
  )
  assert.deepEqual(flightVoice.inserted, [], 'nothing is inserted while OpenRouter is still thinking')

  // The switch happens exactly here, between the request and its answer.
  await flightView.unmount()
  flightVoice.props.inputActions.insertText = () => { throw new Error('disposed composer') }
  flightVoice.props.inputActions.submit = () => { throw new Error('disposed composer') }
  const otherVoice = voiceProps()
  otherVoice.props.sessionId = 'session-2'
  const otherView = await mount(flightMic.Component, otherVoice.props)
  assert.equal(flight.calls.find(c => c.lease).lease.released, false, 'navigation cannot release the origin')
  assert.equal(flight.calls.find(c => c.endpoint === 'openrouter-voice/transcribe').signal.aborted, false)
  release({ ok: true, value: { text: 'переключили таб', audioSeconds: 1, inferenceSeconds: 1, model: 'google/gemini-3.5-transcribe' } })
  await settle(flightView.act)
  assert.deepEqual(flight.calls.filter(c => c.content).map(c => [c.sessionId, c.content]), [
    ['session-1', [{ type: 'text', text: 'переключили таб' }]],
  ], 'send reaches the origin exactly once despite a dead composer')
  assert.deepEqual(otherVoice.inserted, [])
  assert.deepEqual(otherVoice.submitted, [])
  assert.equal(flight.calls.find(c => c.lease).lease.released, true)
  await otherView.unmount()
  const returned = await mount(flightMic.Component, flightVoice.props)
  assert.equal(returned.container.querySelector('[data-voice-activity]'), null, 'returning does not show a draft conflict')
  await returned.unmount()

  // --- the composer that recorded is gone ------------------------------------

  release = undefined
  const orphan = await mockContext({
    ...answers,
    transcribe: () => new Promise((resolve) => { release = resolve }),
  })
  exports.apply(orphan)
  const orphanMic = orphan.registrations.find((entry) => entry.slot === 'conversation.input.activity')
  const stuckVoice = voiceProps({ stuck: true })
  const orphanView = await mount(orphanMic.Component, stuckVoice.props)
  await click(orphanView.act, orphanView.container.querySelector('button'))
  await settle(orphanView.act)
  await click(orphanView.act, orphanView.container.querySelector('button[aria-label="stop"]'))
  await settle(orphanView.act)
  await orphanView.unmount()
  release({ ok: true, value: { text: 'черновик ушёл', audioSeconds: 1, inferenceSeconds: 1, model: 'google/gemini-3.5-transcribe' } })
  await settle(orphanView.act)
  assert.deepEqual(stuckVoice.inserted, [], 'a composer that refuses the insert receives nothing')

  // The transcript waits for its own session instead of vanishing with the view.
  const parkedView = await mount(orphanMic.Component, stuckVoice.props)
  await settle(parkedView.act)
  const parkedRow = parkedView.container.querySelector('[data-voice-activity]')
  assert.equal(parkedRow.getAttribute('data-voice-activity'), 'feedback', 'the parked transcript returns with its session')
  assert.match(parkedView.container.textContent, /insertUnavailable/, 'a truly unavailable editor keeps text without a draft-change warning')
  stuckVoice.control.stuck = false
  const insertButton = [...parkedView.container.querySelectorAll('button')].find((element) => element.textContent === 'insert')
  assert.ok(insertButton, 'the parked transcript offers the stock insert action')
  await click(parkedView.act, insertButton)
  await settle(parkedView.act)
  assert.deepEqual(stuckVoice.inserted, ['черновик ушёл'], 'the parked transcript inserts into the composer that came back')
  assert.equal(parkedView.container.querySelector('[data-voice-activity]'), null, 'and the row collapses')
  await parkedView.unmount()



  // Host rejection preserves recognized text, releases the origin, and never
  // claims success just because a composer submit function returned void.
  const rejected = await mockContext({ ...answers,
    prompt: () => ({ ok: false, error: { message: 'host rejected' } }),
  })
  exports.apply(rejected)
  const rejectedMic = rejected.registrations.find(e => e.slot === 'conversation.input.activity')
  const rejectedVoice = voiceProps({ stuck: true, draft: 'keep this draft', attachments: ['keep-attachment'] })
  rejected.setInput('session-1', rejectedVoice.input)
  const rejectedView = await mount(rejectedMic.Component, rejectedVoice.props)
  await click(rejectedView.act, rejectedView.container.querySelector('button'))
  await settle(rejectedView.act)
  await click(rejectedView.act, rejectedView.container.querySelector('button[aria-label="start.send"]'))
  await settle(rejectedView.act)
  assert.equal(rejectedView.container.querySelector('[role="status"]').title, 'hello world')
  assert.deepEqual(rejected.calls.find(c => c.content).content, [
    { type: 'attachment', id: 'keep-attachment' },
    { type: 'text', text: 'keep this draft\nhello world' },
  ])
  assert.equal(rejectedVoice.control.draft, 'keep this draft', 'a rejected combined send never clears typed text')
  assert.deepEqual(rejectedVoice.control.attachments, ['keep-attachment'], 'a rejected combined send never clears attachments')
  assert.equal(rejected.calls.find(c => c.lease).lease.released, true)
  await click(rejectedView.act, rejectedView.container.querySelector('button[aria-label="discard"]'))
  await rejectedView.unmount()

  // Explicit cancellation, unlike navigation, releases and invalidates delivery.
  let finishCancelled
  const cancelled = await mockContext({ ...answers,
    transcribe: () => new Promise(resolve => { finishCancelled = resolve }),
  })
  exports.apply(cancelled)
  const cancelledMic = cancelled.registrations.find(e => e.slot === 'conversation.input.activity')
  const cancelledView = await mount(cancelledMic.Component, voiceProps().props)
  await click(cancelledView.act, cancelledView.container.querySelector('button'))
  await settle(cancelledView.act)
  await click(cancelledView.act, cancelledView.container.querySelector('button[aria-label="start.send"]'))
  await settle(cancelledView.act)
  await click(cancelledView.act, cancelledView.container.querySelector('button[aria-label="cancel"]'))
  finishCancelled(answers.transcribe)
  await settle(cancelledView.act)
  assert.equal(cancelled.calls.filter(c => c.content).length, 0)
  assert.equal(cancelled.calls.find(c => c.lease).lease.released, true)
  assert.equal(cancelled.calls.find(c => c.endpoint === 'openrouter-voice/transcribe').signal.aborted, true)
  await cancelledView.unmount()

  // --- failure paths -------------------------------------------------------

  const failing = await mockContext({
    ...answers,
    transcribe: { ok: false, error: { code: 'provider-failed', message: 'nope', details: {} } },
  })
  exports.apply(failing)
  const failingMic = failing.registrations.find((entry) => entry.slot === 'conversation.input.activity')
  const failingVoice = voiceProps()
  const failingView = await mount(failingMic.Component, failingVoice.props)
  await click(failingView.act, failingView.container.querySelector('button'))
  await settle(failingView.act)
  await click(failingView.act, failingView.container.querySelector('button[aria-label="stop"]'))
  await settle(failingView.act)
  assert.equal(failing.calls.filter((entry) => entry.endpoint === 'openrouter-voice/transcribe').length, 1)
  assert.equal(
    failingView.container.querySelector('[data-voice-activity]').getAttribute('data-voice-activity'),
    'feedback',
    'a provider failure lands in the stock feedback state',
  )
  assert.match(failingView.container.textContent, /failed/, 'the failure sentence names the reason')
  assert.deepEqual(failingVoice.inserted, [], 'nothing is inserted on failure')
  assert.deepEqual(failingVoice.submitted, [], 'nothing is submitted on failure')

  dom.setDenied(true)
  await click(failingView.act, failingView.container.querySelector('button[aria-label="retryRecording"]'))
  await settle(failingView.act)
  assert.match(failingView.container.textContent, /permission/, 'a denied microphone reports the stock permission sentence')
  dom.setDenied(false)
  await failingView.unmount()

  // --- edits before recognition are normal, not draft conflicts --------------

  let resolveEdited
  const editedContext = await mockContext({ ...answers,
    transcribe: () => new Promise(resolve => { resolveEdited = resolve }),
  })
  exports.apply(editedContext)
  const editedMic = editedContext.registrations.find(e => e.slot === 'conversation.input.activity')
  const editedVoice = voiceProps({ draft: 'initial ' })
  editedVoice.props.sessionId = 'session-edited'
  editedContext.setInput('session-edited', editedVoice.input)
  const editedView = await mount(editedMic.Component, editedVoice.props)
  await click(editedView.act, editedView.container.querySelector('[aria-label="start"]'))
  await settle(editedView.act)
  editedVoice.edit('typed during recording ')
  await click(editedView.act, editedView.container.querySelector('[aria-label="stop"]'))
  await settle(editedView.act)
  // Both the text and caret may move while recognition is on the wire.
  editedVoice.edit('left right', 5)
  resolveEdited(answers.transcribe)
  await settle(editedView.act)
  assert.equal(editedVoice.control.draft, 'left hello worldright', 'plain stop inserts at the CURRENT caret and revision')
  assert.deepEqual(editedVoice.inserted, ['hello world'])
  assert.equal(editedView.container.querySelector('[data-voice-activity]'), null, 'editing never surfaces a conflict banner')
  await editedView.unmount()

  // Background sends use a live resident origin draft, not a start-time or
  // unmounted React snapshot; edits made while awaiting acknowledgement survive.
  let recognizeCombined, acknowledgeCombined
  const combinedContext = await mockContext({ ...answers,
    transcribe: () => new Promise(resolve => { recognizeCombined = resolve }),
    prompt: () => new Promise(resolve => { acknowledgeCombined = resolve }),
  })
  exports.apply(combinedContext)
  const combinedMic = combinedContext.registrations.find(e => e.slot === 'conversation.input.activity')
  const combinedVoice = voiceProps({ draft: 'before recording' })
  combinedVoice.props.sessionId = 'session-combined'
  combinedVoice.control.attachments = ['origin-attachment']
  combinedContext.setInput('session-combined', combinedVoice.input)
  const combinedView = await mount(combinedMic.Component, combinedVoice.props)
  await click(combinedView.act, combinedView.container.querySelector('[aria-label="start"]'))
  await settle(combinedView.act)
  combinedVoice.edit('while recording')
  await click(combinedView.act, combinedView.container.querySelector('[aria-label="start.send"]'))
  await settle(combinedView.act)
  await combinedView.unmount()
  combinedVoice.edit('latest origin draft')
  combinedVoice.props.inputActions.insertText = () => { throw new Error('must not use the visible composer') }
  combinedVoice.props.inputActions.submit = () => { throw new Error('must not use the visible composer') }
  const foreignVoice = voiceProps({ draft: 'other tab draft' })
  foreignVoice.props.sessionId = 'session-foreign'
  combinedContext.setInput('session-foreign', foreignVoice.input)
  const foreignView = await mount(combinedMic.Component, foreignVoice.props)
  recognizeCombined(answers.transcribe)
  await settle(foreignView.act)
  assert.deepEqual(combinedContext.calls.filter(c => c.content).map(c => [c.sessionId, c.content]), [
    ['session-combined', [
      { type: 'attachment', id: 'origin-attachment' },
      { type: 'text', text: 'latest origin draft\nhello world' },
    ]],
  ], 'send combines attachments and the latest text with recognized speech in the origin')
  assert.equal(combinedContext.calls.find(c => c.lease).lease.released, false, 'retention lasts until acknowledgement')
  combinedVoice.edit('new draft written during acknowledgement')
  acknowledgeCombined({ ok: true, value: { accepted: true } })
  await settle(foreignView.act)
  assert.equal(combinedVoice.control.draft, 'new draft written during acknowledgement', 'late typing is not cleared with an older send')
  assert.deepEqual(combinedVoice.control.attachments, [], 'sent attachments are cleared after admission')
  assert.equal(foreignVoice.control.draft, 'other tab draft', 'another chat remains completely untouched')
  assert.equal(combinedContext.calls.find(c => c.lease).lease.released, true)
  await foreignView.unmount()

  // --- a blank chat reserves the workspace's next new chat -------------------

  /** Session-list and workspace rows for one workspace holding these Sessions. */
  const rowsFor = (...rows) => ({
    list: { ids: rows.map((row) => row.id), byId: Object.fromEntries(rows.map((row) => [row.id, { ...row, cwd: '/tmp/project' }])) },
    workspaces: { items: [{ workspaceId: 'ws-1', path: '/tmp/project', sessionIds: rows.map((row) => row.id) }] },
  })
  /** Apply one runtime, mount the control for a Session and open the microphone. */
  const dictate = async (context, sessionId) => {
    exports.apply(context)
    const mic = context.registrations.find((entry) => entry.slot === 'conversation.input.activity')
    const voice = voiceProps()
    voice.props.sessionId = sessionId
    const mounted = await mount(mic.Component, voice.props)
    await click(mounted.act, mounted.container.querySelector('button'))
    await settle(mounted.act)
    assert.equal(
      mounted.container.querySelector('[data-voice-activity]').getAttribute('data-voice-activity'),
      'recording',
      'the microphone opens whatever the workspace looks like',
    )
    return mounted
  }
  /** Cancel the open capture and release the mounted control. */
  const dismiss = async (mounted) => {
    await click(mounted.act, mounted.container.querySelector('button[aria-label="cancel"]'))
    await settle(mounted.act)
    await mounted.unmount()
  }

  // "New chat" reuses the workspace's blank Session, and a dictating Session is
  // still blank until its first prompt is accepted — so without a reservation
  // the button hands the user back the chat they are dictating into.
  const reserve = await mockContext({ ...answers, ...rowsFor({ id: 'session-blank', blank: true }) })
  const reserveView = await dictate(reserve, 'session-blank')
  assert.deepEqual(reserve.created, [{ workspaceId: 'ws-1' }], 'dictating into a blank chat reserves the next new chat')
  await dismiss(reserveView)

  // A chat with history is skipped by the reuse rule anyway: no reservation.
  const settled = await mockContext({ ...answers, ...rowsFor({ id: 'session-history', blank: false }) })
  const settledView = await dictate(settled, 'session-history')
  assert.deepEqual(settled.created, [], 'a chat with history needs no reservation')
  await dismiss(settledView)

  // A blank that already precedes the dictating row wins the button's scan.
  const ahead = await mockContext({ ...answers, ...rowsFor({ id: 'session-spare', blank: true }, { id: 'session-blank', blank: true }) })
  const aheadView = await dictate(ahead, 'session-blank')
  assert.deepEqual(ahead.created, [], 'an earlier blank already serves the next new chat')
  await dismiss(aheadView)

  // A blank behind the dictating row cannot: the scan reaches that row first.
  const stale = await mockContext({ ...answers, ...rowsFor({ id: 'session-blank', blank: true }, { id: 'session-stale', blank: true }) })
  const staleView = await dictate(stale, 'session-blank')
  assert.deepEqual(stale.created, [{ workspaceId: 'ws-1' }], 'a blank behind the dictating chat is not reachable by the button')
  await dismiss(staleView)

  // A Session outside every workspace, or a deployment without the service,
  // must cost the reservation and never the recording.
  const orphaned = await mockContext({ ...answers,
    list: { ids: ['session-blank'], byId: { 'session-blank': { id: 'session-blank', blank: true, cwd: '/tmp/project' } } },
    workspaces: { items: [] },
  })
  const orphanedView = await dictate(orphaned, 'session-blank')
  assert.deepEqual(orphaned.created, [], 'an ungrouped Session reserves nothing')
  await dismiss(orphanedView)

  const bare = await mockContext({ ...answers, workspaces: null })
  const bareView = await dictate(bare, 'session-blank')
  assert.deepEqual(bare.created, [], 'no workspace service means no reservation, and no failure')
  await dismiss(bareView)

  // --- filtered blank chats remain recoverable from foreign composers --------

  const recovery = await mockContext({ ...answers, ...rowsFor({ id: 'session-blank', blank: true }, { id: 'session-other', blank: false }) })
  const captureView = await dictate(recovery, 'session-blank')
  await captureView.unmount()
  const otherProps = voiceProps()
  otherProps.props.sessionId = 'session-other'
  const otherMic = await mount(recovery.registrations.find(e => e.slot === 'conversation.input.activity').Component, otherProps.props)
  const returnButton = otherMic.container.querySelector('[aria-label="returnRecording"]')
  assert.equal(returnButton.disabled, false, 'foreign composer offers recovery rather than a locked mic')
  await click(otherMic.act, returnButton)
  assert.deepEqual(recovery.opened, ['session-blank'], 'return opens the exact hidden original, never the spare chat')
  const track = dom.tracks.at(-1)
  await click(otherMic.act, otherMic.container.querySelector('[aria-label="cancel"]'))
  await settle(otherMic.act)
  assert.ok(track.stopped >= 1, 'cancel from foreign composer releases audio')
  assert.equal(recovery.calls.find(c => c.lease).lease.released, true)
  assert.equal(otherMic.container.querySelector('[aria-label="start"]').disabled, false, 'other chats can dictate again')
  await otherMic.unmount()

  const removedContext = await mockContext({ ...answers, ...rowsFor({ id: 'session-blank', blank: true }) })
  const removedView = await dictate(removedContext, 'session-blank')
  await removedView.unmount()
  const removedTrack = dom.tracks.at(-1)
  removedContext.removeSession('session-blank')
  assert.ok(removedTrack.stopped >= 1, 'actual origin removal releases a background microphone')
  assert.equal(removedContext.calls.find(c => c.lease).lease.released, true)

  let resolveRemovedTranscription
  const removedFlight = await mockContext({ ...answers, ...rowsFor({ id: 'session-removed-flight', blank: true }),
    transcribe: () => new Promise(resolve => { resolveRemovedTranscription = resolve }),
  })
  const removedFlightView = await dictate(removedFlight, 'session-removed-flight')
  await click(removedFlightView.act, removedFlightView.container.querySelector('[aria-label="start.send"]'))
  await settle(removedFlightView.act)
  assert.equal(typeof resolveRemovedTranscription, 'function')
  await removedFlightView.unmount()
  removedFlight.removeSession('session-removed-flight')
  await resolveRemovedTranscription(answers.transcribe)
  assert.equal(removedFlight.calls.filter(c => c.content).length, 0, 'removed origins cannot receive a late transcript')
  assert.equal(removedFlight.calls.find(c => c.endpoint?.endsWith('/transcribe')).signal.aborted, true)
  assert.equal(removedFlight.calls.find(c => c.lease).lease.released, true)

  // --- the resident composer keeps the row expanded across tab switches -----

  // The harness InputBar holds its own expanded state and clears it in a
  // *passive* effect keyed on sessionId. A child's layout effect runs first, so
  // a single assertion is overwritten on the way back and the capture row ends
  // up squeezed into the collapsed slot next to the model selector. This parent
  // mirrors that contract exactly.
  const { createRoot } = await import('react-dom/client')
  const react = await import('react')
  let releaseResident
  const resident = await mockContext({
    ...answers,
    ...rowsFor({ id: 'session-resident', blank: true }),
    transcribe: () => new Promise((resolve) => { releaseResident = resolve }),
  })
  let nativeSubmits = 0
  exports.apply(resident)
  const residentMic = resident.registrations.find((entry) => entry.slot === 'conversation.input.activity')
  const residentVoice = voiceProps()
  residentVoice.props.sessionId = 'session-resident'
  function Composer({ sessionId, Mic, props }) {
    const [activity, setActivity] = react.useState(false)
    react.useEffect(() => {
      setActivity(false)
    }, [sessionId])
    return react.createElement('div', { 'data-activity': String(activity) },
      // SlotOutlet adds an addressable display:contents wrapper. It does not
      // affect flex layout, but DOES affect CSS child combinators.
      react.createElement('div', { 'data-toolbar': '' },
        react.createElement('div', { 'data-activity-seat': '' },
          react.createElement('div', {
            'data-slot': 'conversation.input.activity', style: { display: 'contents' },
          }, react.createElement(Mic, { ...props, sessionId, onActiveChange: setActivity }))),
        react.createElement('button', { 'data-native-stop': '', type: 'button' }, 'agent stop'),
        react.createElement('button', {
          'data-native-submit': '', type: 'button', onClick: () => { nativeSubmits++ },
        }, 'native submit'),
        // Non-portal Tooltip content can follow its button in the DOM.
        react.createElement('div', { role: 'tooltip' }, 'native send tooltip')),
      react.createElement('div', null,
        react.createElement('button', { 'data-unrelated-submit': '', type: 'button' }, 'other composer submit')))

  }
  const composerHost = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(composerHost)
  const composerRoot = createRoot(composerHost)
  const renderComposer = async (sessionId) => {
    await react.act(async () => {
      composerRoot.render(react.createElement(Composer, { sessionId, Mic: residentMic.Component, props: residentVoice.props }))
    })
  }
  const activityOf = () => composerHost.querySelector('[data-activity]').getAttribute('data-activity')
  const nativeButton = () => composerHost.querySelector('[data-native-submit]')
  const primaryButton = () => composerHost.querySelector('button.ovo_primary')
  const isVisible = (button) => globalThis.window.getComputedStyle(button).display !== 'none'
  const assertSingleSend = () => {
    assert.equal(isVisible(nativeButton()), false, 'only this composer native submit is hidden')
    assert.ok(primaryButton(), 'one blue voice submit replaces it')
    assert.equal(composerHost.querySelectorAll('button.ovo_primary').length, 1)
    assert.equal(isVisible(primaryButton()), true)
    assert.equal(isVisible(composerHost.querySelector('[data-native-stop]')), true, 'agent stop is not hidden')
    assert.equal(isVisible(composerHost.querySelector('[data-unrelated-submit]')), true, 'other composers are unaffected')
  }

  await renderComposer('session-resident')
  assert.equal(isVisible(nativeButton()), true, 'native submit is visible before recording')
  assert.equal(activityOf(), 'false', 'an idle composer starts collapsed')
  await click(react.act, composerHost.querySelector('button'))
  await settle(react.act)
  assert.equal(composerHost.querySelector('[data-voice-activity]').getAttribute('data-voice-activity'), 'recording')
  await settle(react.act)
  assert.equal(activityOf(), 'true', 'recording expands the resident composer')
  assertSingleSend()
  assert.equal(primaryButton().disabled, false)
  const primaryStyle = globalThis.window.getComputedStyle(primaryButton())
  assert.equal(primaryStyle.width, '34px', 'stock submit width')
  assert.equal(primaryStyle.height, '34px', 'stock submit height')
  assert.equal(primaryStyle.borderRadius, '999px', 'stock submit shape')
  assert.equal(primaryStyle.transform, 'translateY(-2px)', 'stock submit alignment')
  assert.equal(primaryStyle.display, 'grid', 'stock centered icon layout')
  assert.equal(primaryButton().querySelector('svg').getAttribute('viewBox'), '0 0 16 16')
  assert.equal(primaryButton().querySelector('svg').getAttribute('width'), '16')
  assert.match(primaryButton().querySelector('path').getAttribute('d'), /L9 3\.95577V15\.0417H7/,
    'the stock up-arrow replaces the old paper-plane icon')
  const voiceSheet = globalThis.document.querySelector('style[data-plugin-css="openrouter-voice"]')
  assert.ok(voiceSheet.textContent.includes('background:var(--dsw-alias-button-info-fill)'), 'stock blue theme token')
  assert.ok(voiceSheet.textContent.includes('.ovo_primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}'),
    'stock blue hover token')

  await renderComposer('session-other')
  await settle(react.act)
  assert.equal(activityOf(), 'true', 'switching away expands the recovery indicator instead of disabling the mic')
  assert.ok(composerHost.querySelector('button[aria-label="returnRecording"]'), 'other tab can return to the origin')
  assert.equal(isVisible(nativeButton()), true, 'other tab keeps ordinary submit')
  assert.equal(primaryButton(), null)

  await renderComposer('session-resident')
  await settle(react.act)
  assert.equal(
    composerHost.querySelector('[data-voice-activity]').getAttribute('data-voice-activity'),
    'recording',
    'the live recording is still there',
  )
  assert.equal(activityOf(), 'true', 'returning re-expands the row instead of squeezing it')
  assertSingleSend()

  await click(react.act, primaryButton())
  await settle(react.act)
  assert.equal(composerHost.querySelector('[data-voice-activity]').dataset.voiceActivity, 'transcribing')
  assertSingleSend()
  assert.equal(primaryButton().disabled, true, 'blue submit stays disabled while recognition is pending')
  assert.equal(globalThis.window.getComputedStyle(primaryButton()).opacity, '0.4', 'stock disabled opacity')
  await click(react.act, primaryButton())
  assert.equal(resident.calls.filter(c => c.endpoint === 'openrouter-voice/transcribe').length, 1, 'cannot send twice')
  releaseResident(answers.transcribe)
  await settle(react.act)
  assert.equal(primaryButton(), null)
  assert.equal(isVisible(nativeButton()), true, 'normal submit returns after sending')
  assert.equal(nativeSubmits, 0, 'voice send does not submit the existing draft')
  assert.deepEqual(resident.calls.filter(c => c.content).map(c => [c.sessionId, c.content]), [
    ['session-resident', [{ type: 'text', text: 'hello world' }]],
  ], 'the blue button sends dictation to the original session exactly once')
  await click(react.act, nativeButton())
  assert.equal(nativeSubmits, 1, 'native handler remains untouched after restoring')

  await click(react.act, composerHost.querySelector('button[aria-label="start"]'))
  await settle(react.act)
  assertSingleSend()
  await click(react.act, composerHost.querySelector('button[aria-label="cancel"]'))
  await settle(react.act)
  assert.equal(activityOf(), 'false', 'cancelling releases the expanded state')
  assert.equal(isVisible(nativeButton()), true, 'cancelling immediately restores native submit')
  assert.equal(primaryButton(), null)

  await click(react.act, composerHost.querySelector('button[aria-label="start"]'))
  await settle(react.act)
  assertSingleSend()
  await click(react.act, primaryButton())
  await settle(react.act)
  releaseResident({ ok: false, error: { code: 'failed', message: 'recognition failed' } })
  await settle(react.act)
  assert.equal(composerHost.querySelector('[data-voice-activity]').dataset.voiceActivity, 'feedback')
  assert.equal(isVisible(nativeButton()), true, 'recognition error restores native submit even with feedback expanded')
  assert.equal(primaryButton(), null)
  await click(react.act, composerHost.querySelector('button[aria-label="cancel"]'))
  await settle(react.act)
  await react.act(async () => composerRoot.unmount())
  composerHost.remove()

  // The voice control's context stays applied until every component under
  // test has used the runtime seam it owns.
  assert.equal(typeof dispose, 'function')
  const teardown = dispose()
  if (teardown !== void 0) await teardown

  console.log('openrouter-voice client checks passed')
}

await suite()
