/**
 * Browser half of `dsh-openrouter-voice`.
 *
 * This module is a loader bundle, not an ES module: it hands a factory to
 * `window.__ModuleLoader__.load` and pulls its externals from the injected
 * client runtime.
 *
 * The control is a one-to-one copy of the harness voice control that used to
 * live in the composer: the same seat (`conversation.input.activity`, the
 * compact action right after the model selector), the same collapsed
 * microphone trigger, the same expanded capture row — cancel, waveform,
 * status, stop, insert/retry — with the same markup, styles, icons and
 * strings. The following things differ:
 *
 *   1. recognition goes to this plugin's own host routes on the shared `/api`
 *      channel, which call OpenRouter; no experimental speech package is
 *      involved;
 *   2. while dictating, one blue button visually replaces the stock submit
 *      (identical CSS and arrow). It stops, recognizes and sends directly to
 *      the origin session; the plain stop button still only inserts;
 *   3. a capture is *not* cancelled by attention: `blur` and
 *      `visibilitychange` are ignored, so dictation keeps running after the
 *      window loses focus or the tab is hidden, and ends only on the stop
 *      button, the send button, Escape, or the duration limit;
 *   4. the capture belongs to the module, not to the mounted control: a tab
 *      switch — which unmounts the control or hands it another `sessionId` —
 *      interrupts neither the recording, nor a transcription already on the
 *      wire, nor the transcript on its way back into the composer;
 *   5. dictating into a blank chat reserves that workspace's *next* new chat,
 *      so "New chat" keeps opening a new chat while the voice message is still
 *      being transcribed (see `reserveNextChat`).
 */

window.__ModuleLoader__.load({
	id: "dsh-openrouter-voice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		var useState = react.useState,
			useRef = react.useRef,
			useEffect = react.useEffect,
			useLayoutEffect = react.useLayoutEffect,
			useSyncExternalStore = react.useSyncExternalStore;
		var jsx = jsxRuntime.jsx,
			jsxs = jsxRuntime.jsxs;
		var createElement = react.createElement;
		var Button = primitives.Button,
			Input = primitives.Input,
			Tooltip = primitives.Tooltip,
			StateDot = primitives.StateDot;
		var IconMicrophoneOutlineRegular = primitives.IconMicrophoneOutlineRegular,
			IconStopFillRegular = primitives.IconStopFillRegular,
			IconCloseOutlineRegular = primitives.IconCloseOutlineRegular,
			IconRefreshOutlineRegular = primitives.IconRefreshOutlineRegular;
		//#region identity
		/** Dictionary namespace and CSS marker of this plugin. */
		var NS = "openrouter-voice";
		/** Shared Connection channel every browser RPC rides on. */
		var API_CHANNEL = "/api";
		/**
		* Endpoint prefix owned by the host half. The host registers one exact
		* Fetch route per endpoint under `/api`, which is the extension point a
		* third-party plugin can own; a private channel cannot be registered
		* because the carrier binds channels through the web server service.
		*/
		var ROUTE = "openrouter-voice";
		/** Canonical recording the host expects: 16 kHz mono PCM16. */
		var SAMPLE_RATE = 16000;
		/** Recording bound used until the host reports its own. */
		var FALLBACK_MAX_SECONDS = 180;
		//#endregion
		//#region styles
		/**
		* The voice-control rules are the shipped ones verbatim under this
		* plugin's prefix, so the control keeps the stock geometry, colours and
		* motion instead of approximating them.
		*/
		var css = [
			".ovo_trigger{flex:none;width:28px;padding:0}",
			".ovo_triggerAnchor{flex:none;display:inline-flex}",
			".ovo_recovery{display:flex;align-items:center;gap:4px;min-width:0}",
			".ovo_recoveryOpen,.ovo_recoveryCancel{border:0;border-radius:6px;padding:6px;background:var(--dsw-specific-selector);color:inherit;font:inherit;font-size:12px;cursor:pointer}",
			".ovo_recoveryOpen{display:flex;align-items:center;gap:6px;min-width:0;text-align:left}",
			".ovo_recoveryOpen svg{flex:none;color:var(--dsw-alias-button-info-fill)}",
			".ovo_recoveryOpen span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".ovo_recoveryCancel{flex:none;display:inline-flex;align-items:center;justify-content:center;padding:5px}",
			".ovo_recovery button:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
			".ovo_captureRow{align-items:center;gap:12px;width:100%;min-width:0;min-height:34px;display:flex}",
			".ovo_roundButton{corner-shape:round;background:var(--dsw-specific-selector);border-radius:50%;flex:none;width:32px;height:32px;padding:0}",
			".ovo_roundButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}",
			// Stock InputBar.primary rules, with only the class renamed. Use a
			// native button below, not the primitive Button (which adds its own skin).
			".ovo_primary{corner-shape:round;background:var(--dsw-alias-button-info-fill);color:#fff;cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;width:34px;height:34px;transition:background-color .1s;display:grid;transform:translateY(-2px)}",
			".ovo_primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}",
			".ovo_primary:disabled{opacity:.4;cursor:default}",
			// The native submit is the last direct button in the activity seat's
			// toolbar. Scope to our row; no generated class names, global hiding,
			// DOM mutation, or interception of the native submit handler. Removing
			// this marker (idle/feedback/unmount) restores it automatically.
			// SlotOutlet's display:contents div still exists in the DOM. Follow
			// its stable data-slot anchor, and use last-of-type because a Tooltip
			// bubble may follow the native button.
			':has(> div > [data-slot="conversation.input.activity"] .ovo_captureRow[data-voice-replaces-submit]) > button:last-of-type{display:none}',
			".ovo_waveform{width:0;min-width:24px;height:24px;color:var(--dsw-alias-label-secondary);flex:1;display:block}",
			".ovo_activityMessage{min-width:0;color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis;flex:1;align-items:center;gap:8px;font-size:12px;display:flex;overflow:hidden}",
			".ovo_inlineAction{flex:none}",
			".ovo_preferences{gap:12px;margin:18px 0;font-size:13px;display:grid}",
			".ovo_preferences{min-width:0;width:100%}",
			".ovo_preferences label{min-width:0;gap:6px;display:grid}",
			".ovo_preferences select,.ovo_preferences .ovo_inlineGrow{width:100%;min-width:0;box-sizing:border-box}",
			".ovo_preferences p{overflow-wrap:anywhere}",
			".ovo_modelActions{display:flex;flex-wrap:wrap;gap:8px}",
			".ovo_preferences select{border:.5px solid var(--dsw-alias-border-l1);color:inherit;font:inherit;background:0 0;border-radius:6px;padding:6px 10px}",
			".ovo_preferences p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".ovo_inline{display:flex;align-items:center;gap:8px;min-width:0}",
			".ovo_inlineGrow{flex:1;min-width:0}",
		].join("");
		if (typeof document !== "undefined") {
			var style = document.querySelector("style[data-plugin-css=" + JSON.stringify(NS) + "]");
			if (style === null) {
				style = document.createElement("style");
				style.dataset.plugin = "dsh-openrouter-voice";
				style.dataset.pluginCss = NS;
				document.head.appendChild(style);
			}
			// A client reload must update the existing sheet, not keep old rules.
			style.textContent = css;
		}
		//#endregion
		//#region locales
		var en = {
			dictate: "Dictate",
			start: "Start recording",
			"start.send": "Record and send",
			stop: "Stop and transcribe",
			"stop.send": "Stop, transcribe and send",
			cancel: "Cancel",
			discard: "Discard transcript",
			insert: "Insert text",
			requesting: "Allow microphone access to continue…",
			transcribingShort: "Transcribing…",
			recording: "Recording…",
			recordingElsewhere: "Recording in progress",
			returnRecording: "Return to the dictation chat",
			retryRecording: "Record again",
			empty: "No speech recognized",
			insertUnavailable: "Text is ready. Insert it when the editor is available.",
			tooLarge: "The recording exceeds the service limit. Try a shorter recording.",
			failed: "Speech recognition failed: {message}",
			unavailable: "This browser cannot record audio. Use a browser with microphone support.",
			permission: "Microphone access is disabled. Allow it in browser and system settings.",
			cancelled: "Voice input cancelled.",
			interrupted: "Recording was interrupted. Please try again.",
			noKey: "OpenRouter has no key yet: add OPENROUTER_API_KEY in the Models settings.",
			"model.label": "Transcription model",
			"model.hint": "OpenRouter model used by the microphone in the composer",
			"model.custom": "Custom model ID",
			"model.customOption": "Custom ID…",
			"model.saving": "Saving…",
			"model.save": "Save",
			"model.refresh": "Refresh the OpenRouter catalog",
			"model.loading": "Loading the OpenRouter catalog…",
			"model.catalogFailed": "Could not load the OpenRouter catalog",
			"model.saveFailed": "Could not save the model",
			"model.keyMissing": "{ref} is not stored yet — add it in the Models settings",
			"model.current": "Saved model: {model}",
		};
		var ru = {
			dictate: "Диктовка",
			start: "Начать запись",
			"start.send": "Записать и отправить",
			stop: "Остановить и распознать",
			"stop.send": "Остановить, распознать и отправить",
			cancel: "Отмена",
			discard: "Отбросить транскрипт",
			insert: "Вставить текст",
			requesting: "Разрешите доступ к микрофону…",
			transcribingShort: "Распознавание…",
			recording: "Запись…",
			recordingElsewhere: "Идёт запись",
			returnRecording: "Вернуться в чат с диктовкой",
			retryRecording: "Записать снова",
			empty: "Речь не распознана",
			insertUnavailable: "Текст готов. Его можно вставить, когда поле ввода освободится.",
			tooLarge: "Запись превышает лимит сервиса. Попробуйте записать короче.",
			failed: "Не удалось распознать: {message}",
			unavailable: "Этот браузер не умеет записывать звук. Нужен браузер с поддержкой микрофона.",
			permission: "Доступ к микрофону запрещён. Разрешите его в браузере и системе.",
			cancelled: "Голосовой ввод отменён.",
			interrupted: "Запись прервалась. Попробуйте ещё раз.",
			noKey: "У OpenRouter ещё нет ключа: добавьте OPENROUTER_API_KEY в настройках «Модели».",
			"model.label": "Модель транскрибации",
			"model.hint": "Модель OpenRouter для голосового ввода в поле сообщения",
			"model.custom": "Свой ID модели",
			"model.customOption": "Свой ID…",
			"model.saving": "Сохраняю…",
			"model.save": "Сохранить",
			"model.refresh": "Обновить каталог OpenRouter",
			"model.loading": "Загружаю каталог OpenRouter…",
			"model.catalogFailed": "Не удалось загрузить каталог OpenRouter",
			"model.saveFailed": "Не удалось сохранить модель",
			"model.keyMissing": "{ref} ещё не сохранён — добавьте его в настройках «Модели»",
			"model.current": "Сохранённая модель: {model}",
		};
		//#endregion
		//#region runtime seams
		/** The live client context; rebound on every apply so a reload re-arms it. */
		var runtime = { ctx: null };

		/**
		* Call one endpoint on this plugin's own host channel.
		* @param endpoint - endpoint name inside the channel.
		* @param payload - channel-owned request payload.
		* @param signal - optional caller cancellation.
		* @returns the plugin's `{ ok, value }` / `{ ok, error }` envelope.
		*/
		async function callRpc(endpoint, payload, signal) {
			var ctx = runtime.ctx;
			var call = ctx && ctx.connection && ctx.connection.rpc ? ctx.connection.rpc.call : void 0;
			if (typeof call !== "function") {
				return { ok: false, error: { code: "no-connection", message: "the harness connection is unavailable" } };
			}
			try {
				// The Connection result *is* this plugin's envelope: the host
				// handler answers `{ ok, value }` / `{ ok, error }` directly.
				var result = await call.call(ctx.connection.rpc, API_CHANNEL, ROUTE + "/" + endpoint, payload, signal);
				if (result !== null && typeof result === "object" && typeof result.ok === "boolean") return result;
				return { ok: false, error: { code: "bad-result", message: "the host returned an unexpected result" } };
			} catch (error) {
				return { ok: false, error: { code: "transport", message: messageOf(error) } };
			}
		}

		/** @param error - anything thrown. @returns a printable message. */
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		/** @param props - component props. @returns a translation function that never throws. */
		function translator(props) {
			var t = props ? props.t : void 0;
			if (typeof t === "function") return t;
			return function (key) {
				return (en[key] ?? key);
			};
		}

		/**
		* Build one keyed child.
		*
		* `react.createElement` takes the key beside the props, which keeps
		* React's development warning about a `key` inside a props object out of
		* the console that a hand-written loader bundle would otherwise produce.
		* @param type - element type.
		* @param key - stable child key.
		* @param props - element props without a key.
		* @returns the element.
		*/
		function item(type, key, props) {
			return createElement(type, Object.assign({ key: key }, props));
		}
		//#endregion
		//#region capture (the shipped recorder, vendored)
		/** Microphone failure whose kind selects the user-facing sentence. */
		var RecordingError = class extends Error {
			constructor(kind) {
				super(kind);
				this.kind = kind;
				this.name = "RecordingError";
			}
		};

		/**
		* Encode mono samples as the canonical 16 kHz PCM16 WAV the host validates.
		* @param samples - mono samples in [-1, 1].
		* @returns the WAV bytes.
		*/
		function encodeWave(samples) {
			var bytes = new Uint8Array(44 + samples.length * 2);
			var view = new DataView(bytes.buffer);
			var write = (offset, text) => {
				for (var index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
			};
			write(0, "RIFF");
			view.setUint32(4, 36 + samples.length * 2, true);
			write(8, "WAVE");
			write(12, "fmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, SAMPLE_RATE, true);
			view.setUint32(28, SAMPLE_RATE * 2, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			write(36, "data");
			view.setUint32(40, samples.length * 2, true);
			for (var index = 0; index < samples.length; index++) {
				var value = Math.max(-1, Math.min(1, samples[index]));
				view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
			}
			return bytes;
		}

		/**
		* Encode the binary recording for the JSON channel carrier.
		* @param bytes - complete recording.
		* @returns base64 with no data URL prefix.
		*/
		function audioBase64(bytes) {
			var text = "";
			for (var index = 0; index < bytes.length; index += 8192) text += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192));
			return btoa(text);
		}

		/** One microphone acquisition, including a permission prompt that may settle after cancellation. */
		var Recording = class {
			constructor(onDispose) {
				this.onDispose = onDispose;
				this.samples = new Float32Array(256);
				this.chunks = [];
				this.lifetime = new AbortController();
			}
			/**
			* Acquire the microphone for this recording.
			* @param onError - receives failures during capture, before asynchronous resource release finishes.
			* @returns after capture starts.
			*/
			async start(onError) {
				var devices = navigator.mediaDevices;
				if (!devices || typeof MediaRecorder === "undefined") throw new RecordingError("unavailable");
				var stream;
				try {
					stream = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
				} catch (error) {
					if (error instanceof DOMException && error.name === "NotAllowedError") throw new RecordingError("permission");
					throw error;
				}
				if (this.lifetime.signal.aborted) {
					stream.getTracks().forEach((track) => track.stop());
					throw new RecordingError("cancelled");
				}
				this.stream = stream;
				try {
					this.context = new AudioContext();
					this.analyser = this.context.createAnalyser();
					this.analyser.fftSize = this.samples.length;
					this.context.createMediaStreamSource(stream).connect(this.analyser);
					this.recorder = new MediaRecorder(stream);
					this.recorder.ondataavailable = (event) => {
						if (!this.lifetime.signal.aborted && event.data.size > 0) this.chunks.push(event.data);
					};
					this.recorder.onerror = () => {
						if (this.lifetime.signal.aborted) return;
						this.dispose().catch(() => void 0);
						try {
							onError?.(new RecordingError("interrupted"));
						} catch (error) {
							console.error("[openrouter-voice] recording error handler failed", error);
						}
					};
					this.recorder.start();
				} catch (error) {
					await this.dispose();
					throw error;
				}
			}
			/**
			* Read the live microphone signal.
			* @returns the measured RMS level, or zero outside capture.
			*/
			amplitude() {
				if (!this.analyser) return 0;
				this.analyser.getFloatTimeDomainData(this.samples);
				var sum = 0;
				for (var index = 0; index < this.samples.length; index++) sum += this.samples[index] * this.samples[index];
				return Math.sqrt(sum / this.samples.length);
			}
			/**
			* Finish capture and resample the recording.
			* @param maxDurationSeconds - truncate timer overshoot to the host limit.
			* @returns one canonical WAV recording.
			*/
			async stop(maxDurationSeconds) {
				var recorder = this.recorder;
				var context = this.context;
				if (!recorder || !context || recorder.state !== "recording") {
					await this.dispose();
					throw new RecordingError("empty");
				}
				try {
					await new Promise((resolve, reject) => {
						recorder.onstop = () => resolve();
						recorder.onerror = () => reject(new RecordingError("empty"));
						recorder.stop();
					});
					if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
					this.lifetime.signal.throwIfAborted();
					var blob = new Blob(this.chunks, { type: recorder.mimeType });
					if (blob.size === 0) throw new RecordingError("empty");
					var decoded = await context.decodeAudioData(await blob.arrayBuffer());
					this.lifetime.signal.throwIfAborted();
					var frames = Math.max(1, Math.floor(Math.min(decoded.duration, maxDurationSeconds) * SAMPLE_RATE));
					var offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
					var source = offline.createBufferSource();
					source.buffer = decoded;
					source.connect(offline.destination);
					source.start();
					var resampled = await offline.startRendering();
					this.lifetime.signal.throwIfAborted();
					return encodeWave(resampled.getChannelData(0));
				} finally {
					await this.dispose();
				}
			}
			/**
			* Release the recorder, the audio context and the microphone.
			* @returns after every resource settles.
			*/
			async dispose() {
				if (this.disposal) return this.disposal;
				this.disposal = (async () => {
					this.lifetime.abort(new RecordingError("cancelled"));
					try {
						if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
					} catch (error) {
						console.warn("[openrouter-voice] could not stop the recorder", error);
					}
					if (this.stream) {
						for (const track of this.stream.getTracks()) {
							try {
								track.stop();
							} catch (error) {
								console.warn("[openrouter-voice] could not release a microphone track", error);
							}
						}
					}
					if (this.context && this.context.state !== "closed") {
						try {
							await this.context.close();
						} catch (error) {
							console.warn("[openrouter-voice] could not close the audio context", error);
						}
					}
					this.analyser = void 0;
					this.stream = void 0;
					try {
						this.onDispose?.();
					} catch (error) {
						console.warn("[openrouter-voice] recording disposer failed", error);
					}
				})();
				return this.disposal;
			}
		};

		/**
		* Release one recording without throwing at its caller.
		* @param capture - recording, possibly already disposed.
		*/
		async function disposeRecording(capture) {
			try {
				await capture?.dispose();
			} catch (error) {
				console.warn("[openrouter-voice] could not release the recording", error);
			}
		}

		/**
		* Live microphone waveform: the shipped 80-bar SVG, driven by the RMS
		* level of the active recording.
		* @param props - the active recording and its accessible label.
		* @returns the waveform element.
		*/
		function Waveform({ recording, label }) {
			var svg = useRef(null);
			useEffect(() => {
				var bars = Array.from(svg.current.querySelectorAll("line")).reverse().map((element) => ({ element: element, level: 0 }));
				var frame;
				var previous = -Infinity;
				var draw = (now) => {
					if (now - previous >= 50) {
						previous = now;
						var next = recording?.amplitude() ?? 0;
						for (const bar of bars) {
							var previousLevel = bar.level;
							bar.level = next;
							next = previousLevel;
							var height = 1 + Math.min(1, bar.level * 5) * 17;
							bar.element.setAttribute("y1", String(20 - height));
							bar.element.setAttribute("y2", String(20 + height));
						}
					}
					frame = requestAnimationFrame(draw);
				};
				frame = requestAnimationFrame(draw);
				return () => {
					cancelAnimationFrame(frame);
				};
			}, [recording]);
			return jsx("svg", {
				ref: svg,
				className: "ovo_waveform",
				viewBox: "0 0 640 40",
				preserveAspectRatio: "none",
				role: "img",
				"aria-label": label,
				children: Array.from({ length: 80 }, (_, index) =>
					jsx("line", {
						x1: index * 8 + 4,
						x2: index * 8 + 4,
						y1: "19",
						y2: "21",
						stroke: "currentColor",
						strokeWidth: "3",
						strokeLinecap: "round",
						opacity: 0.25 + index / 120,
					}, index)),
			});
		}
		//#endregion
		//#region voice session
		/**
		* "New chat" reuses the blank Session of a workspace instead of opening a
		* second one, and a Session only stops counting as blank when its first
		* prompt is accepted. A voice message spends its whole transcription on the
		* wire before that prompt exists, so during exactly that window the button
		* would hand the user back the chat they are dictating into.
		*
		* Reserving the workspace's next blank here — the same call the harness
		* itself makes when it finds no blank to reuse — means the button finds
		* that reserved row first. Nothing is created for a Session that already
		* has history (the reuse rule skips those anyway), and nothing is created
		* while a blank still precedes the dictating Session in the reuse scan.
		* @param sessionId - the Session the pending voice message belongs to.
		*/
		async function reserveNextChat(sessionId) {
			var ctx = runtime.ctx;
			var sessions = ctx ? ctx.sessions : void 0;
			var workspaces = ctx && typeof ctx.get === "function" ? ctx.get("workspaces") : void 0;
			if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== "function") return;
			if (typeof sessions.create !== "function") return;
			if (!workspaces || !workspaces.list || typeof workspaces.list.getSnapshot !== "function") return;
			var list = sessions.list.getSnapshot();
			if (!list || !list.byId) return;
			var target = list.byId[sessionId];
			if (target === void 0 || target.blank !== true) return;
			var workspace = workspaceHolding(workspaces.list.getSnapshot(), sessionId);
			if (workspace === void 0) return;
			var listed = false;
			for (const id of list.ids) {
				// Reaching the dictating Session first is what the button would do.
				if (id === sessionId) {
					listed = true;
					break;
				}
				var row = list.byId[id];
				if (row === void 0 || row.blank !== true) continue;
				if (row.cwd !== workspace.path) continue;
				if (workspace.sessionIds.indexOf(id) === -1) continue;
				return;
			}
			// A row the button never scans cannot be reused by it.
			if (!listed) return;
			try {
				await sessions.create({ workspaceId: workspace.workspaceId });
			} catch (error) {
				console.warn("[openrouter-voice] could not reserve the next new chat", error);
			}
		}

		/**
		* @param snapshot - the workspace list snapshot.
		* @param sessionId - Session to place.
		* @returns the workspace whose rows hold that Session, if any.
		*/
		function workspaceHolding(snapshot, sessionId) {
			var items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
			for (const item of items) {
				if (item && Array.isArray(item.sessionIds) && item.sessionIds.indexOf(sessionId) !== -1) return item;
			}
			return void 0;
		}

		/**
		* The capture in flight, owned by the module rather than by a mounted
		* control.
		*
		* A tab switch tears the control down — the same component comes back with
		* a different `sessionId`, or unmounts altogether — and none of that may
		* interrupt the user: not a recording that is still capturing, not a
		* transcription already on the wire, and not a transcript on its way back
		* into the composer. So the capture, its cancellation token and the
		* composer it must reach live here; React only renders what this reports.
		* @returns the module-owned voice session the controls render from.
		*/
		var voice = (function () {
			/** The capture in flight, or null. */
			var active = null;
			/** Bumped by every cancellation, so an older async run can bail out. */
			var generation = 0;
			/** Transcripts that arrived without a live composer: sessionId → state. */
			var held = new Map();
			/** Mounted controls watching this session. */
			var listeners = [];
			/** Bumped on every visible change; controls subscribe to this alone. */
			var version = 0;

			/** Tell every mounted control that something changed. */
			function publish() {
				version += 1;
				for (const listener of listeners.slice()) {
					try {
						listener();
					} catch (error) {
						console.warn("[openrouter-voice] a voice control listener failed", error);
					}
				}
			}

			/**
			* What one session's composer should render right now.
			* @param sessionId - the session that composer belongs to.
			* @returns the phase plus any message and transcript waiting for it.
			*/
			function view(sessionId) {
				if (active !== null && active.sessionId === sessionId) {
					return { phase: active.phase, message: "", pending: "" };
				}
				var waiting = held.get(sessionId);
				if (waiting !== void 0) return { phase: "feedback", message: waiting.message, pending: waiting.pending };
				return { phase: "idle", message: "", pending: "" };
			}

			/**
			* Park an outcome for one session and release the capture it came from.
			* @param record - the capture that produced the outcome.
			* @param message - the sentence the composer shows.
			* @param pending - transcript the composer could not insert itself.
			*/
			function release(record) {
				if (record.timer !== void 0) clearTimeout(record.timer);
				if (record.unwatch) {
					record.unwatch();
					record.unwatch = null;
				}
				if (record.reference) {
					record.reference.release();
					record.reference = null;
				}
			}

			function hold(record, message, pending) {
				release(record);
				active = null;
				held.set(record.sessionId, { message: message, pending: pending });
				publish();
			}

			/**
			* @param t - translator.
			* @param failure - anything thrown.
			* @returns the stock sentence for that failure.
			*/
			function describe(t, failure) {
				if (failure instanceof RecordingError) return t(failure.kind);
				return t("failed", { message: failure instanceof Error ? failure.message : String(failure) });
			}

			/**
			* Open the microphone for one session and keep recording until stopped.
			* @param t - that session's translator.
			* @param inputActions - that session composer's action face.
			* @param sessionId - the session the capture belongs to.
			*/
			async function start(t, inputActions, sessionId) {
				if (active !== null) return;
				var run = ++generation;
				var record = {
					capture: new Recording(),
					abort: new AbortController(),
					actions: inputActions,
					sessionId: sessionId,
					t: t,
					input: null,
					maxDurationSeconds: FALLBACK_MAX_SECONDS,
					maxAudioBytes: Infinity,
					phase: "requesting",
					send: false,
					timer: void 0,
					originMounted: true,
				};
				active = record;
				held.delete(sessionId);
				publish();
				// The user has committed a message to this Session; keep the "New
				// chat" button usable while it is still being transcribed.
				void reserveNextChat(sessionId);
				try {
					// Own the origin generation independently of navigation. This also
					// keeps its session-scoped draft shell alive for plain dictation.
					record.reference = runtime.ctx.sessions.retain(sessionId, { source: "controllerOperation" });
					var binding = await record.reference.ready;
					if (run !== generation) return;
					record.session = binding.session;
					// This is the retained origin's resident input, not the visible tab.
					// Its store stays live when the activity control unmounts.
					record.input = runtime.ctx.conversation.input.for(binding.ctx);
					// Navigation only hides blank rows. Actual removal, however, must
					// release the microphone even when no origin control is mounted.
					var checkRemoved = () => {
						if (active === record && record.session.getSnapshot?.().removed === true) cancel(sessionId);
					};
					if (typeof record.session.subscribe === "function") record.unwatch = record.session.subscribe(checkRemoved);
					checkRemoved();
					if (run !== generation) return;
					var settings = await callRpc("config", {});
					if (run !== generation) return;
					if (settings.ok === true) {
						if (typeof settings.value.maxDurationSeconds === "number") record.maxDurationSeconds = settings.value.maxDurationSeconds;
						if (typeof settings.value.maxAudioBytes === "number") record.maxAudioBytes = settings.value.maxAudioBytes;
						if (settings.value.hasKey !== true) {
							hold(record, t("noKey"), "");
							return;
						}
					}
					await record.capture.start((failure) => {
						if (run !== generation || active !== record || record.phase === "transcribing") return;
						hold(record, describe(t, failure), "");
					});
					if (run !== generation || active !== record) {
						await disposeRecording(record.capture);
						return;
					}
					record.phase = "recording";
					publish();
					record.timer = setTimeout(() => void stop(false), Math.max(1, record.maxDurationSeconds) * 1000);
				} catch (failure) {
					await disposeRecording(record.capture);
					if (run === generation) hold(record, describe(t, failure), "");
				}
			}

			/**
			* Stop the capture, recognize it and put the transcript into the very
			* composer it was recorded for — whether or not that composer is still
			* on screen, and whether or not this control instance is still alive.
			* @param send - combine the origin draft with speech and send directly; otherwise insert at its current caret.
			*/
			async function stop(send) {
				var record = active;
				if (record === null || record.phase !== "recording") return;
				record.phase = "transcribing";
				if (send !== void 0) record.send = send;
				var run = generation;
				if (record.timer !== void 0) clearTimeout(record.timer);
				publish();
				try {
					var audio = await record.capture.stop(record.maxDurationSeconds);
					if (run !== generation) return;
					if (audio.byteLength > record.maxAudioBytes) {
						hold(record, record.t("tooLarge"), "");
						return;
					}
					var result = await callRpc("transcribe", { audioBase64: audioBase64(audio) }, record.abort.signal);
					if (run !== generation) return;
					if (result.ok !== true) {
						hold(record, record.t("failed", { message: result.error && result.error.message ? result.error.message : "" }), "");
						return;
					}
					if (result.value.text === "") {
						hold(record, record.t("empty"), "");
						return;
					}
					record.transcript = result.value.text;
					if (record.send === true) {
						// Read the latest origin draft AFTER recognition, so typing during
						// recording/transcription is included. Leave other tabs untouched.
						var sentDraft = record.input.state.getSnapshot();
						var combined = sentDraft.draft.trim() === "" ? record.transcript
							: sentDraft.draft + (/\s$/.test(sentDraft.draft) ? "" : "\n") + record.transcript;
						var attachmentIds = Array.from(sentDraft.attachmentIds || []);
						// Use the resident composer's attachment admission: it serializes
						// images/upload receipts and owns previews and registry retirement.
						// Never silently fall back to text-only if preparation fails.
						var hasAttachments = attachmentIds.length > 0 && typeof runtime.ctx?.conversation?.sendSession === "function";
						var receipt = hasAttachments
							? await runtime.ctx.conversation.sendSession(record.session, combined, attachmentIds, "queue", record.abort.signal)
							: await record.session.prompt([{ type: "text", text: combined }], "queue", record.abort.signal);
						if (run !== generation) return;
						if (hasAttachments ? receipt.kind !== "success" : !receipt.ok) {
							hold(record, record.t("failed", { message: (hasAttachments ? receipt.text : receipt.error?.message) || "Send failed" }), record.transcript);
							return;
						}
						// Clear only the text that was actually accepted. A newer draft
						// typed while awaiting the host must never be discarded.
						var currentDraft = record.input.state.getSnapshot();
						if (sentDraft.draft !== "" && currentDraft.phase === "plain" && currentDraft.draftRev === sentDraft.draftRev)
							record.input.setDraft("");
						if (attachmentIds.length > 0) {
							if (typeof record.input.removeAttachment === "function") {
								for (const id of attachmentIds) record.input.removeAttachment(id);
							} else if (typeof record.input.commitSend === "function") {
								record.input.commitSend(attachmentIds);
							}
						}
					} else if (!record.actions.insertText(record.transcript, record.actions.captureInsertion())) {
						hold(record, record.t("insertUnavailable"), record.transcript);
						return;
					}
					release(record);
					active = null;
					publish();
				} catch (failure) {
					await disposeRecording(record.capture);
					if (run === generation) hold(record, describe(record.t, failure), record.transcript || "");
				}
			}

			/**
			* Abandon one session's capture or its parked transcript. The capture is
			* global, so only the session that owns it may end it.
			* @param sessionId - the session whose composer asked to stop.
			*/
			function cancel(sessionId) {
				var record = active;
				if (record !== null && record.sessionId === sessionId) {
					generation += 1;
					active = null;
					if (record.timer !== void 0) clearTimeout(record.timer);
					record.abort.abort();
					release(record);
					disposeRecording(record.capture);
				}
				held.delete(sessionId);
				publish();
			}

			/**
			* Put a parked transcript into the composer that is on screen again.
			* @param sessionId - the session that composer belongs to.
			* @param inputActions - that composer's action face.
			*/
			function insertHeld(sessionId, inputActions) {
				var waiting = held.get(sessionId);
				if (waiting === void 0 || waiting.pending === "") return;
				if (inputActions.insertText(waiting.pending, inputActions.captureInsertion())) {
					held.delete(sessionId);
					publish();
				}
			}

			function setOriginMounted(id, mounted) {
				if (active !== null && active.sessionId === id) {
					active.originMounted = mounted;
					publish();
				}
			}

			return {
				version: () => version,
				subscribe: (listener) => {
					listeners.push(listener);
					return () => {
						var at = listeners.indexOf(listener);
						if (at !== -1) listeners.splice(at, 1);
					};
				},
				dispose: () => {
					if (active) cancel(active.sessionId);
					held.clear();
				},
				busy: () => active !== null,
				origin: () => active === null ? null : { sessionId: active.sessionId, phase: active.phase, originMounted: active.originMounted !== false },
				open: (sessionId) => runtime.ctx?.get?.("uiWorkspace")?.openSession(sessionId),
				setOriginMounted,
				view,
				start,
				stop,
				cancel,
				insertHeld,
				recording: (sessionId) => (active !== null && active.sessionId === sessionId && active.phase === "recording" ? active.capture : void 0),
			};
		})();
		//#endregion
		//#region voice control
		/**
		* The composer voice control: the shipped layout and behaviour, wired to
		* this plugin's OpenRouter channel, plus one instant "recognize and send"
		* action while a recording is open.
		*
		* The control owns no capture state of its own. It renders what the
		* module-level voice session reports for this session and forwards clicks,
		* so remounting it — a tab switch, a session change, a reloaded slot —
		* reattaches to a live recording or a parked transcript instead of killing
		* either.
		* @param props - activity-slot props: input actions, lock state, expansion.
		* @returns the collapsed trigger or the expanded capture row.
		*/
		/** An additive, root-scoped escape hatch for a filtered blank chat. */
		function VoiceRecovery({ wide, t, force }) {
			useSyncExternalStore(voice.subscribe, voice.version);
			var origin = voice.origin();
			if (origin === null) return null;
			if (!force && origin.originMounted) return null;
			var label = t(origin.phase === "recording" ? "recordingElsewhere" : origin.phase === "transcribing" ? "transcribingShort" : "requesting");
			return jsx("div", {
				className: "ovo_recovery",
				"data-voice-origin": origin.sessionId,
				children: [
					item("button", "return", {
						type: "button", className: "ovo_recoveryOpen", title: t("returnRecording"),
						"aria-label": t("returnRecording"),
						onClick: () => voice.open(origin.sessionId),
						children: [item(IconMicrophoneOutlineRegular, "icon", { size: 16 }), wide !== false && item("span", "label", { children: label })],
					}),
					item("button", "cancel", {
						type: "button", className: "ovo_recoveryCancel", title: t("cancel"), "aria-label": t("cancel"),
						onClick: () => voice.cancel(origin.sessionId), children: jsx(IconCloseOutlineRegular, { size: 14 }),
					}),
				],
			});
		}

		function VoiceControl({ sessionId, inputActions, locked, onActiveChange, t }) {
			useSyncExternalStore(voice.subscribe, voice.version);

			useLayoutEffect(() => {
				voice.setOriginMounted(sessionId, true);
				return () => {
					voice.setOriginMounted(sessionId, false);
				};
			}, [sessionId]);
			var view = voice.view(sessionId);
			var phase = view.phase;
			var message = view.message;
			var pending = view.pending;
			var origin = voice.origin();
			var elsewhere = origin !== null && origin.sessionId !== sessionId;
			var expanded = phase !== "idle" || elsewhere;
			var replacesSubmit = phase === "requesting" || phase === "recording" || phase === "transcribing";
			var blocked = locked === true || voice.busy();

			// The composer owns an "expanded" flag of its own and clears it in a
			// *passive* effect keyed on `sessionId` — which runs after this child's
			// layout effects. Asserting our state once per change therefore loses
			// on the way back into a tab: the capture row is rendered into the
			// collapsed slot, squeezed next to the model selector. Re-asserting on
			// every commit wins that race and settles as soon as the composer
			// agrees, since an unchanged `useState` value renders nothing.
			var notify = useRef(onActiveChange);
			useLayoutEffect(() => {
				notify.current = onActiveChange;
				onActiveChange?.(expanded);
			});
			// Release the composer only when this control really goes away.
			useLayoutEffect(() => () => {
				notify.current?.(false);
			}, []);

			useEffect(() => {
				// Escape is a session-scoped stop: it ends this session's capture
				// or drops its parked transcript, and nothing else.
				var escape = (event) => {
					if (event.key === "Escape" && voice.view(sessionId).phase !== "idle") {
						event.preventDefault();
						voice.cancel(sessionId);
					}
				};
				document.addEventListener("keydown", escape);
				return () => {
					document.removeEventListener("keydown", escape);
				};
			}, [sessionId]);

			// Another composer must offer recovery, not a permanently disabled mic.
			// This is not the origin submit replacement: its native send stays visible.
			if (elsewhere) return jsx(VoiceRecovery, { wide: true, t: t, force: true });

			if (!expanded) {
				return jsx(Tooltip, {
					label: t("dictate"),
					disabled: blocked,
					side: "top",
					portal: true,
					children: jsx("span", {
						className: "ovo_triggerAnchor",
						children: jsx(Button, {
							className: "ovo_trigger",
							size: "sm",
							disabled: blocked,
							"aria-label": t("start"),
							onMouseDown: (event) => {
								event.preventDefault();
							},
							onClick: () => void voice.start(t, inputActions, sessionId),
							children: jsx(IconMicrophoneOutlineRegular, { size: 18 }),
						}),
					}),
				});
			}

			return jsxs("div", {
				className: "ovo_captureRow",
				"data-voice-activity": phase,
				"data-voice-replaces-submit": replacesSubmit ? "" : void 0,
				children: [
					item(Button, "cancel", {
						type: "button",
						className: "ovo_roundButton",
						size: "sm",
						"aria-label": t(pending ? "discard" : "cancel"),
						onClick: () => voice.cancel(sessionId),
						children: jsx(IconCloseOutlineRegular, { size: 14 }),
					}),
					phase === "recording"
						? item(Waveform, "waveform", { recording: voice.recording(sessionId), label: t("recording") })
						: item("span", "status", {
							className: "ovo_activityMessage",
							role: "status",
							title: pending || message,
							children: [
								(phase === "requesting" || phase === "transcribing") ? item(StateDot, "dot", { state: "ongoing" }) : null,
								phase === "feedback" ? message : t(phase === "requesting" ? "requesting" : "transcribingShort"),
							],
						}),
					phase === "recording"
						? item(Button, "stop", {
							type: "button",
							className: "ovo_roundButton",
							size: "sm",
							"aria-label": t("stop"),
							onClick: () => void voice.stop(false),
							children: jsx(IconStopFillRegular, { size: 14 }),
						})
						: null,
					replacesSubmit
						? item(Tooltip, "send", {
							label: t("stop.send"),
							side: "top",
							delayMs: 500,
							disabled: phase !== "recording",
							children: jsx("button", {
								type: "button",
								className: "ovo_primary",
								"aria-label": t("start.send"),
								disabled: phase !== "recording",
								onMouseDown: (event) => event.preventDefault(),
								onClick: () => void voice.stop(true),
								// Exact stock submit glyph, not the paper-plane icon.
								children: jsx("svg", {
									viewBox: "0 0 16 16",
									width: "16",
									height: "16",
									"aria-hidden": true,
									children: jsx("path", {
										d: "M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z",
										fill: "currentColor",
									}),
								}),
							}),
						})
						: null,
					phase === "feedback"
						? (pending
							? item(Button, "insert", {
								className: "ovo_inlineAction",
								size: "sm",
								type: "button",
								onClick: () => voice.insertHeld(sessionId, inputActions),
								children: t("insert"),
							})
							: item(Button, "retry", {
								className: "ovo_roundButton",
								size: "sm",
								type: "button",
								"aria-label": t("retryRecording"),
								disabled: locked === true,
								onClick: () => void voice.start(t, inputActions, sessionId),
								children: jsx(IconMicrophoneOutlineRegular, { size: 18 }),
							}))
						: null,
				],
			});
		}
		//#endregion
		//#region transcription model row
		/**
		* Plugin configuration for the OpenRouter transcription model. A single
		* selector chooses a catalog model or custom mode; custom IDs have their
		* own full-width field, separate from the save and refresh actions.
		* @param props - plugin bundle configuration slot props.
		* @returns the row element.
		*/
		function ModelRow(props) {
			var t = translator(props);
			var configState = useState(null);
			var config = configState[0];
			var setConfig = configState[1];
			var modelsState = useState([]);
			var models = modelsState[0];
			var setModels = modelsState[1];
			var draftState = useState("");
			var draft = draftState[0];
			var setDraft = draftState[1];
			var statusState = useState("model.loading");
			var status = statusState[0];
			var setStatus = statusState[1];
			// null infers the mode from the loaded model; explicit selection wins.
			var customState = useState(null);
			var custom = customState[0];
			var setCustom = customState[1];
			// Keep the custom draft independently of the selected catalog model.
			var customDraft = useRef("");
			var catalogSettled = useRef(false);
			var savingState = useState(false);
			var saving = savingState[0];
			var setSaving = savingState[1];

			useEffect(() => {
				var controller = typeof AbortController === "function" ? new AbortController() : null;
				var signal = controller === null ? void 0 : controller.signal;
				void (async () => {
					var loaded = await callRpc("config", {}, signal);
					if (loaded.ok !== true) {
						setStatus("model.catalogFailed");
						return;
					}
					if (signal !== void 0 && signal.aborted) return;
					setConfig(loaded.value);
					setDraft(loaded.value.model);
					var catalog = await callRpc("models", {}, signal);
					if (signal !== void 0 && signal.aborted) return;
					catalogSettled.current = true;
					if (catalog.ok === true) {
						setModels(catalog.value.models);
						setStatus("ready");
					} else {
						setStatus("model.catalogFailed");
					}
				})();
				return () => {
					if (controller !== null) controller.abort();
				};
			}, []);

			/** Reload the catalog, bypassing the host cache. */
			var refresh = async () => {
				setStatus("model.loading");
				var catalog = await callRpc("models", { force: true });
				if (catalog.ok === true) {
					setModels(catalog.value.models);
					setStatus("ready");
				} else {
					setStatus("model.catalogFailed");
				}
			};

			/** Persist the current draft, if it differs from the stored model. */
			var save = async () => {
				var model = draft.trim();
				if (model === "" || saving || config === null) return;
				setSaving(true);
				var result = await callRpc("set-model", { model: model });
				setSaving(false);
				if (result.ok !== true) {
					console.warn("[openrouter-voice] could not save the model", result.error);
					setStatus("model.saveFailed");
					return;
				}
				setConfig(result.value);
				setDraft(result.value.model);
				setStatus("ready");
			};

			var current = config === null ? "" : config.model;
			var isCustom = config !== null && (custom === null ? catalogSettled.current && !models.some((entry) => entry.id === draft) : custom);
			var options = models.slice();
			// A refresh can remove an entry; never let the native select fall back
			// visually to another model while the draft still holds this ID.
			if (!isCustom && draft !== "" && !options.some((entry) => entry.id === draft)) {
				options.unshift({ id: draft, name: draft });
			}
			var note = status === "model.loading"
				? t("model.loading")
				: status === "model.catalogFailed"
					? t("model.catalogFailed")
					: status === "model.saveFailed"
						? t("model.saveFailed")
						: config !== null && config.hasKey !== true
							? t("model.keyMissing", { ref: config.apiKeyRef })
							: t("model.current", { model: current === "" ? "—" : current });
			var dirty = draft.trim() !== "" && draft.trim() !== current;

			return jsxs("div", {
				className: "ovo_preferences",
				children: [
					item("label", "model", {
						children: [
							item("span", "text", { children: t("model.label") }),
							item("select", "select", {
								value: isCustom ? "" : draft,
								disabled: config === null || saving || !catalogSettled.current,
								onChange: (event) => {
									var value = event.target.value;
									if (isCustom) customDraft.current = draft;
									setCustom(value === "");
									setDraft(value === "" ? customDraft.current : value);
								},
								children: [item("option", "custom-option", { value: "", children: t("model.customOption") })].concat(options.map((entry) =>
									item("option", entry.id, {
										value: entry.id,
										children: entry.name === entry.id ? entry.id : entry.name + " — " + entry.id,
									}))),
							}),
						],
					}),
					isCustom ? item("label", "custom", {
						children: [
							item("span", "text", { children: t("model.custom") }),
							item(Input, "input", {
								className: "ovo_inlineGrow",
								value: draft,
								disabled: config === null || saving,
								"aria-label": t("model.custom"),
								placeholder: "provider/model-id",
								autoComplete: "off",
								spellCheck: false,
								onChange: (event) => {
									setCustom(true);
									setDraft(event.target.value);
								},
							}),
						],
					}) : null,
					item("div", "actions", {
						className: "ovo_modelActions",
						children: [
							item(Button, "save", {
								variant: "primary", size: "sm",
								disabled: !dirty || saving || config === null,
								onClick: () => void save(),
								children: t(saving ? "model.saving" : "model.save"),
							}),
							item(Button, "refresh", {
								size: "sm",
								disabled: status === "model.loading" || saving || config === null,
								onClick: () => void refresh(),
								children: t("model.refresh"),
							}),
						],
					}),
					item("p", "note", { children: note }),
					item("p", "hint", { children: t("model.hint") }),
				],
			});
		}
		//#endregion
		//#region mount
		/** Client services this bundle needs before it can mount anything. */
		var inject = ["connection", "slots", "locale", "sessions", "conversation"];

		/**
		* Register the voice control in the shipped seat — the compact action
		* right after the model selector — and the model row on this plugin's page.
		* @param ctx - client runtime.
		*/
		function apply(ctx) {
			runtime.ctx = ctx;
			ctx.effect(function () {
				return ctx.locale.register(NS, { en: en, ru: ru });
			}, "openrouter-voice: locale dictionaries");
			// The activity seat is a single slot: the shipped voice control owns
			// it too, so a collision is reported instead of breaking the page.
			ctx.slots.inject("conversation.input.activity", function () {
				try {
					return ctx.slots.register({ name: "conversation.input.activity", locale: NS }, VoiceControl);
				} catch (error) {
					console.warn("[openrouter-voice] the composer voice seat is taken; remove the experimental voice-input bundle", error);
					return void 0;
				}
			});
			ctx.slots.inject("plugins.bundle.config", function () {
				return ctx.slots.register({ name: "plugins.bundle.config", key: "dsh-openrouter-voice", locale: NS }, ModelRow);
			});
			console.info("[openrouter-voice] mounted " + new Date().toISOString());
			return function () {
				voice.dispose();
				runtime.ctx = null;
				console.info("[openrouter-voice] unmounted " + new Date().toISOString());
			};
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.internals = {
			NS: NS,
			API_CHANNEL: API_CHANNEL,
			ROUTE: ROUTE,
			SAMPLE_RATE: SAMPLE_RATE,
			en: en,
			ru: ru,
			css: css,
			VoiceControl: VoiceControl,
			VoiceRecovery: VoiceRecovery,
			ModelRow: ModelRow,
			Waveform: Waveform,
			Recording: Recording,
			RecordingError: RecordingError,
			callRpc: callRpc,
			encodeWave: encodeWave,
			audioBase64: audioBase64,
			disposeRecording: disposeRecording,
			runtime: runtime,
		};
		return module.exports;
	}
});
