/**
 * Interview feature (browser) - the chat: send a message, grow the streamed reply bubble.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ voice.js NEVER calls the LLM. It only produces a transcript string.       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * There are exactly TWO ways a user message reaches sendText():
 *
 *   1) Voice : mic -> voice.js (STT) -> onTranscript(text) --+   (wired in app.js)
 *   2) Typing: text box / [Senden] / Enter -> submitInput() -+-> sendText(text)
 *                                                               |
 *                                       POST /api/sessions/{id}/turn/stream
 *                                                               v
 *                       backend: interview/routes.py turn_stream() -> pipeline.stream_turn()
 *
 * and ONE way a reply gets spoken: sendText() calls voice.speak(reply) at the end
 * (voice.js -> POST /api/tts -> mp3). Text streams; audio starts after the full reply.
 *
 * While a turn is in flight: assistant bubble with thinking dots, then reply stream.
 * Failed / interrupted turns: last message stays as user, loading clears, red error frame
 * + [Wiederholen] under that bubble (appState.turnError). Mic during thinking aborts the fetch.
 *
 * BUTTON -> HANDLER -> BACKEND   (backend docs: features/interview/routes.py)
 * ==========================================================================
 *   [Senden]  #sendBtn, [Enter] in #textInput  -> submitInput() -> sendText()
 *   [Sprechen] #micBtn  (session open only)    -> voice.onMicClick (STT) -> onTranscript
 *                                                 -> sendText()
 *   Home/picker: #speakDock hidden; start via #confirmNewBtn only.
 *   Mic lives in #speakDock between qaList and proposalList (above conflicts), user/right side.
 *   [Wiederholen] on failed user bubble        -> sendText(text, { isRetry: true })
 */

import { api, apiStream } from "../../shared/api.js";
import { esc, fmtTime, fmtTs } from "../../shared/format.js";
import { modelManager } from "../../shared/model-manager.js";
import {
  activeId, activeSession, appState, clearProcessBusy, clearTurnError, confirmInterruptProcess,
  isPicker, nav, setLoading, setProcessBusy, setTurnError,
} from "../../shared/state.js";
import { isBrowserLlm, prefs } from "../prefs/prefs.js";
import { t } from "../prefs/chrome-i18n.js";

/**
 * @param {{voice: object, sessions: object}} deps
 *   voice    - createVoice() result (STT/TTS)
 *   sessions - createSessions() result (patchActiveSession, refreshPicker, ...)
 */
export function createChat({ voice, sessions }) {
  const qaList = document.getElementById("qaList");
  const chatScroll = document.getElementById("chatScroll");
  const textInput = document.getElementById("textInput");

  /** @type {AbortController|null} */
  let turnAbort = null;
  let turnGen = 0; // bumps per server turn: an older turn's late `done` must not repaint over a newer one
  /** @type {Promise<void>|null} Resolves when the previous turn's background dossier extract finishes. */
  let inFlightExtractPromise = null;

  /** Append one chat bubble (both assistant & user as bubbles + timestamp + optional ctx warning). */
  function addQa(role, text, ts, warning = "") {
    const wrap = document.createElement("div");
    wrap.className = "team-qa";
    const body = esc(text);
    const stamp = fmtTime(ts || new Date().toISOString());
    const timeHtml = stamp ? `<time class="team-qa__time" datetime="${esc(ts || "")}">${esc(stamp)}</time>` : "";
    const warnHtml = warning
      ? `<div class="team-qa__ctx-warn" role="status">⚠ ${esc(warning)}</div>`
      : "";
    wrap.innerHTML = role === "assistant"
      ? `<div class="team-qa__assistant">
          <div class="team-qa__a-avatar assistant" aria-hidden="true">AI</div>
          <div class="team-qa__bubble assistant-bubble">
            <p class="team-qa__q">${body}</p>
            ${warnHtml}
            ${timeHtml}
          </div>
        </div>`
      : `<div class="team-qa__a">
          <div class="team-qa__a-avatar user">Du</div>
          <div class="team-qa__a-bubble user-bubble">
            <p>${body}</p>
            ${timeHtml}
          </div>
        </div>`;
    qaList.appendChild(wrap);
    chatScroll.scrollTop = chatScroll.scrollHeight;
    return wrap;
  }

  /** Attach or update the inline token/context warning inside an existing assistant bubble. */
  function syncBubbleWarning(qEl, session) {
    const bubbleEl = qEl?.closest?.(".assistant-bubble");
    if (!bubbleEl || !session) return;
    const lastAss = [...(session.messages || [])].reverse().find((m) => m.role === "assistant");
    const warn = lastAss?.warning || "";
    let wEl = bubbleEl.querySelector(".team-qa__ctx-warn");
    if (!warn) {
      wEl?.remove();
      return;
    }
    if (!wEl) {
      wEl = document.createElement("div");
      wEl.className = "team-qa__ctx-warn";
      wEl.setAttribute("role", "status");
      const timeEl = bubbleEl.querySelector(".team-qa__time");
      if (timeEl) timeEl.before(wEl);
      else bubbleEl.appendChild(wEl);
    }
    wEl.textContent = `⚠ ${warn}`;
  }

  /** Left-aligned assistant "typing" bubble (same lane as real replies). */
  function showThinkingBubble(label = "Thinking…") {
    const existing = qaList.querySelector(".team-qa--thinking");
    if (existing) {
      setThinkingLabel(existing, label);
      placeSpeakDock();
      return existing;
    }
    const wrap = document.createElement("div");
    wrap.className = "team-qa team-qa--thinking";
    wrap.setAttribute("aria-live", "polite");
    wrap.setAttribute("aria-busy", "true");
    wrap.innerHTML = `<div class="team-qa__assistant">
      <div class="team-qa__a-avatar assistant" aria-hidden="true">AI</div>
      <div class="team-qa__bubble team-qa__bubble--thinking">
        <span class="team-qa__thinking-label">${esc(label)}</span>
        <span class="team-qa__dots" aria-hidden="true"><i></i><i></i><i></i></span>
      </div>
    </div>`;
    qaList.appendChild(wrap);
    placeSpeakDock();
    chatScroll.scrollTop = chatScroll.scrollHeight;
    return wrap;
  }

  function setThinkingLabel(wrap, label) {
    const el = wrap?.querySelector(".team-qa__thinking-label");
    if (el && label) el.textContent = label;
  }

  /** Turn the thinking bubble into the streaming reply bubble (or create a new one). */
  function promoteThinking(wrap, text) {
    const nowIso = new Date().toISOString();
    const stamp = fmtTime(nowIso);
    if (!wrap || !wrap.isConnected) {
      return addQa("assistant", text, nowIso).querySelector(".team-qa__q");
    }
    wrap.classList.remove("team-qa--thinking");
    wrap.removeAttribute("aria-live");
    wrap.removeAttribute("aria-busy");
    wrap.innerHTML = `<div class="team-qa__assistant">
      <div class="team-qa__a-avatar assistant" aria-hidden="true">AI</div>
      <div class="team-qa__bubble assistant-bubble">
        <p class="team-qa__q"></p>
        ${stamp ? `<time class="team-qa__time" datetime="${esc(nowIso)}">${esc(stamp)}</time>` : ""}
      </div>
    </div>`;
    const q = wrap.querySelector(".team-qa__q");
    q.textContent = text;
    placeSpeakDock();
    chatScroll.scrollTop = chatScroll.scrollHeight;
    return q;
  }

  function removeThinking(wrap) {
    if (wrap?.isConnected) wrap.remove();
    else qaList.querySelector(".team-qa--thinking")?.remove();
  }

  /**
   * Extract / turn busy lives in the topbar (#processBanner) with the session label.
   * Independent of chat bubbles / TTS — stays on after reply unlock while extract runs.
   */
  function showProcessBusy(kind, sessionId, message) {
    const lang = String(activeSession()?.language || "de");
    const fallback = kind === "extract"
      ? t("updatingDossier", lang)
      : t("processingReply", lang);
    setProcessBusy({ kind, sessionId, message: message || fallback });
    voice.setExtractBusy?.(kind === "extract");
  }

  function hideProcessBusy() {
    clearProcessBusy();
    voice.setExtractBusy?.(false);
  }

  function isDossierComplete(session) {
    if (!session) return false;
    const ev = session.evaluation;
    if (ev?.ready_for_closing) return true;
    if (ev && (Number(ev.field_coverage || 0) >= 1 || (Array.isArray(ev.missing_fields) && ev.missing_fields.length === 0))) {
      return true;
    }
    // Also check actual slot fields directly so as soon as 15/15 fields are non-empty (100%),
    // the end state triggers immediately even if evaluation metadata is stale.
    const slots = Object.values(session.objects || {});
    if (!slots.length) return false;
    let total = 0;
    let filled = 0;
    slots.forEach((obj) => {
      Object.values(obj?.fields || {}).forEach((v) => {
        total += 1;
        if (String(v || "").trim()) filled += 1;
      });
    });
    return total > 0 && filled >= total;
  }

  function hasUnsavedChanges(session) {
    if (!session) return false;
    const versions = Array.isArray(session.dossier_versions) ? session.dossier_versions : [];
    if (!versions.length) return true;
    const latest = versions[versions.length - 1];
    return Number(session.turn_index || 0) > Number(latest.turn_index || 0);
  }

  function paintIntakeEndContent(session) {
    const el = document.getElementById("intakeEnd");
    if (!el || !session) return;
    const de = !String(session.language || "de").toLowerCase().startsWith("en");
    const versions = Array.isArray(session.dossier_versions) ? session.dossier_versions : [];
    const vCount = versions.length;
    const latest = vCount ? versions[vCount - 1] : null;
    const dirty = hasUnsavedChanges(session);

    const badge = document.getElementById("intakeEndBadge");
    const copy = document.getElementById("intakeEndCopy");
    const verEl = document.getElementById("intakeEndVersions");
    const contBtn = document.getElementById("intakeEndContinue");
    const saveBtn = document.getElementById("intakeEndFinalize");
    const closeBtn = document.getElementById("intakeEndClose");

    el.dataset.state = !vCount ? "unsaved" : (dirty ? "dirty" : "saved");

    if (badge) {
      if (!vCount) {
        badge.textContent = de ? "Bereit · ungespeichert" : "Ready · unsaved";
      } else if (dirty) {
        badge.textContent = de ? `v${latest.version} · +neue Antworten` : `v${latest.version} · +new answers`;
      } else {
        badge.textContent = de ? `Dossier v${latest.version} gespeichert` : `Dossier v${latest.version} saved`;
      }
    }
    if (copy) {
      if (!vCount) {
        copy.textContent = de
          ? "Alle Kernfelder erfasst — weiter fragen, als v1 speichern oder direkt Speichern & Beenden."
          : "All core fields captured — keep asking, save as v1, or Save & End.";
      } else if (dirty) {
        copy.textContent = de
          ? `Neue Antworten seit v${latest.version} — weiter fragen, als v${vCount + 1} speichern oder Speichern & Beenden.`
          : `New answers since v${latest.version} — keep asking, save v${vCount + 1}, or Save & End.`;
      } else {
        copy.textContent = de
          ? `Dossier v${latest.version} lokal gespeichert (${fmtTs(latest.created_at)}) — weiter fragen für v${vCount + 1} oder Gespräch beenden.`
          : `Dossier v${latest.version} saved locally (${fmtTs(latest.created_at)}) — keep asking for v${vCount + 1} or end chat.`;
      }
    }
    if (verEl) {
      if (!vCount) {
        verEl.hidden = true;
        verEl.innerHTML = "";
      } else {
        const sid = esc(session.id);
        const chips = [...versions].reverse().map((v) => {
          const vid = esc(v.id);
          const pct = Math.round(Number(v.field_coverage || 0) * 100);
          return `<span class="intake-end__vchip">
            <strong>v${esc(String(v.version))}</strong> · ${esc(fmtTs(v.created_at))} · ${pct}%
            <a href="/api/sessions/${sid}/dossiers/${vid}.md" download>MD</a>
            <a href="/api/sessions/${sid}/dossiers/${vid}.pdf" download>PDF</a>
            <a href="/api/sessions/${sid}/dossiers/${vid}.json" download>JSON</a>
          </span>`;
        }).join("");
        verEl.innerHTML = chips;
        verEl.hidden = false;
      }
    }
    if (contBtn) contBtn.textContent = de ? "Weiter fragen" : "Continue asking";
    if (saveBtn) {
      saveBtn.textContent = de ? `Als v${vCount + 1} speichern` : `Save as v${vCount + 1}`;
    }
    if (closeBtn) {
      closeBtn.textContent = dirty
        ? (de ? `Speichern (v${vCount + 1}) & Beenden` : `Save (v${vCount + 1}) & End`)
        : (de ? "Gespräch beenden" : "End chat");
    }
  }

  function showIntakeEnd({ compact = false } = {}) {
    const el = document.getElementById("intakeEnd");
    const app = document.getElementById("app");
    if (el) {
      el.hidden = false;
      el.classList.toggle("is-compact", Boolean(compact));
    }
    if (app) {
      app.dataset.offerEnd = "1";
      if (!compact) delete app.dataset.dismissEnd;
    }
    const s = activeSession();
    if (s) paintIntakeEndContent(s);
    document.getElementById("finalizeBlock")?.classList.add("is-ready");
  }

  function hideIntakeEnd({ userDismiss = false } = {}) {
    const el = document.getElementById("intakeEnd");
    const app = document.getElementById("app");
    const s = activeSession();
    const complete = isDossierComplete(s);
    const hasVersions = Array.isArray(s?.dossier_versions) && s.dossier_versions.length > 0;
    // When dossier is 100% complete (or has saved versions), never hide #intakeEnd completely:
    // collapse it into a compact bar when "Continue asking" is pressed or a turn is sent!
    if ((complete || hasVersions) && s) {
      if (app && userDismiss) app.dataset.dismissEnd = String(s.turn_index ?? "1");
      showIntakeEnd({ compact: true });
      return;
    }
    if (el) {
      el.hidden = true;
      el.classList.remove("is-compact");
    }
    if (app) {
      delete app.dataset.offerEnd;
      if (userDismiss) app.dataset.dismissEnd = String(s?.turn_index ?? "1");
      else delete app.dataset.dismissEnd;
    }
    document.getElementById("finalizeBlock")?.classList.toggle("is-ready", complete);
  }

  /**
   * Auto-trigger END / vX banner as soon as dossier hits 100% (or after any dossier update).
   * If the user pressed "Continue asking" on this turn, keep it visible in compact mode.
   */
  function syncIntakeEnd(session) {
    const app = document.getElementById("app");
    if (!session) {
      const el = document.getElementById("intakeEnd");
      if (el) {
        el.hidden = true;
        el.classList.remove("is-compact");
      }
      return;
    }
    const hasVersions = Array.isArray(session.dossier_versions) && session.dossier_versions.length > 0;
    const complete = isDossierComplete(session);
    document.getElementById("finalizeBlock")?.classList.toggle("is-ready", complete && !session.finalized);
    if (!complete && !hasVersions && app?.dataset.offerEnd !== "1") {
      hideIntakeEnd();
      return;
    }
    // User clicked Continue on this turn — shrink to compact bar instead of disappearing!
    const compact = Boolean(app?.dataset.dismissEnd === String(session.turn_index ?? ""));
    showIntakeEnd({ compact });
  }

  /** Keep the failed user line on the in-memory session so re-render does not drop it. */
  function ensureTrailingUser(session, text) {
    if (!session) return;
    const msgs = session.messages || (session.messages = []);
    const last = msgs[msgs.length - 1];
    if (last && last.role === "user" && last.content === text) return;
    msgs.push({ role: "user", content: text, ts: new Date().toISOString() });
  }

  /** Trailing user message while idle = failed/interrupted turn (show retry). */
  function failedUserText(session) {
    if (!session || appState.loading) return null;
    const msgs = session.messages || [];
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "user") return null;
    return last.content;
  }

  /**
   * Park #speakDock between the chat bubbles and the conflict cards (never inside qaList —
   * innerHTML wipe would destroy the mic). Right-aligned = user side.
   */
  function placeSpeakDock() {
    let dock = document.getElementById("speakDock");
    const intakeEnd = document.getElementById("intakeEnd");
    const proposals = document.getElementById("proposalList");
    if (!dock) {
      dock = document.createElement("div");
      dock.id = "speakDock";
      dock.className = "speak-dock";
    }
    let btn = document.getElementById("micBtn");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.id = "micBtn";
      btn.className = "mic-btn mic-btn--chat";
      btn.setAttribute("aria-pressed", "false");
      btn.innerHTML = `<span class="mic-btn__dot" aria-hidden="true"></span><span class="mic-btn__label">Sprechen</span>`;
    }
    let bar = document.getElementById("listenBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "listen-bar";
      bar.id = "listenBar";
      bar.hidden = true;
      bar.innerHTML = `<canvas class="listen-bar__wave" id="listenWave" width="280" height="36" aria-hidden="true"></canvas>
        <button type="button" class="pill listen-bar__stop" id="listenStopBtn">Stop</button>`;
    }
    if (!dock.contains(btn)) dock.appendChild(btn);
    if (!dock.contains(bar)) dock.appendChild(bar);
    // … qaList → speakDock → intakeEnd → proposalList …
    if (dock) {
      if (intakeEnd) intakeEnd.before(dock);
      else if (proposals) proposals.before(dock);
      else qaList.after(dock);
      voice.syncMicLabels?.();
    }
  }

  function renderChat(session) {
    placeSpeakDock(); // out of qaList before wipe
    const liveBubble = qaList.querySelector(".team-qa--live");
    qaList.innerHTML = "";
    if (!session) {
      placeSpeakDock();
      return;
    }
    const msgs = session.messages || [];
    const failText = failedUserText(session);
    const err = appState.turnError && appState.turnError.sessionId === session.id
      ? appState.turnError
      : null;
    msgs.forEach((m, i) => {
      const wrap = addQa(m.role === "assistant" ? "assistant" : "user", m.content, m.ts, m.warning || "");
      const isFailedUser = failText && i === msgs.length - 1 && m.role === "user";
      if (!isFailedUser) return;
      wrap.classList.add("is-error");
      const detail = err?.message || "Reply failed or interrupted";
      const bar = document.createElement("div");
      bar.className = "team-qa__error";
      bar.innerHTML = `<p class="team-qa__error-msg">${esc(detail)}</p>
        <button type="button" class="pill-outline team-qa__retry" data-act="retry-turn" data-text="${esc(m.content)}">Retry</button>`;
      wrap.appendChild(bar);
    });
    // Re-attach thinking only while waiting (turnHint set). Cleared on first reply delta.
    if (appState.loading && appState.loadingKind === "turn" && appState.turnHint) {
      showThinkingBubble(appState.turnHint);
    } else {
      placeSpeakDock();
    }
    // Keep the live STT bubble while a background extract re-paints the chat.
    if (liveBubble && !qaList.querySelector(".team-qa--live")) {
      qaList.appendChild(liveBubble);
    }
  }

  /**
   * Mic / stop during an in-flight turn: cancel the SSE fetch so sendText lands in catch.
   * Background dossier extract stays running when ``keepExtract`` is set (Speak during update).
   */
  function abortTurn({ keepExtract = false } = {}) {
    const replyBusy = Boolean(appState.loading && appState.loadingKind === "turn");
    if (keepExtract && !replyBusy) return;
    if (turnAbort) {
      try { turnAbort.abort(); } catch { /* ignore */ }
    }
    turnAbort = null;
    inFlightExtractPromise = null;
    nav.turnBusy = false;
    appState.turnHint = null;
    hideProcessBusy();
    if (appState.loading && appState.loadingKind === "turn") setLoading(false);
  }

  /**
   * Register a background extract so sendText waits (does not abort) until it finishes.
   * @returns {() => void} settle callback
   */
  function beginExtractWait() {
    let settled = false;
    let resolve;
    const p = new Promise((res) => { resolve = res; });
    inFlightExtractPromise = p;
    return () => {
      if (settled) return;
      settled = true;
      resolve();
      if (inFlightExtractPromise === p) inFlightExtractPromise = null;
    };
  }

  /**
   * ╔════════════════════════════════════════════════════════════════════════╗
   * ║ sendText(text) - THE ONE PLACE A USER MESSAGE GOES TO THE BACKEND/LLM  ║
   * ╚════════════════════════════════════════════════════════════════════════╝
   *
   *   1. Guard      : ignore empty text, picker view, or a turn already in flight.
   *   2. Optimistic : paint the user's bubble immediately (skip if isRetry).
   *   3. Stream     : POST /api/sessions/{id}/turn/stream, read SSE events:
   *                     event: status -> phase reply | extract (extract only if LLM gated yes)
   *                     event: delta  -> append `text` to a growing assistant bubble
   *                     event: reply  -> spoken text ready: TTS + unlock mic (parallel to extract)
   *                     event: done   -> final payload { session, reply, needs_extract }
   *                     event: error  -> apiStream() throws -> caught below
   *   4. Reconcile  : on reply (messages) and again on done (dossier).
   *   5. Speak      : voice.speak(reply) as soon as `reply` arrives — do not wait for extract.
   *
   * Stale guard: if the user switched conversation mid-request (nav.isStale), the late
   * response is dropped instead of being painted into the wrong chat.
   */
  async function sendText(text, { isRetry = false } = {}) {
    if (isBrowserLlm(prefs.llm)) {
      return sendTextBrowser(text, { isRetry });
    }
    return sendTextServer(text, { isRetry });
  }

  /** Browser Transformers.js path: prepare → worker reply+extract → commit. */
  async function sendTextBrowser(text, { isRetry = false } = {}) {
    const trimmed = (text || "").trim();
    const id = activeId();
    let session = activeSession();
    if (isPicker() || !id || !session || !trimmed || nav.turnBusy || appState.loading) return;
    clearTurnError();
    const seq = nav.seq;
    nav.turnBusy = true;
    ensureTrailingUser(session, trimmed);
    hideIntakeEnd();
    const de = String(session.language || "de").toLowerCase().startsWith("de");
    const waitingForExtract = Boolean(inFlightExtractPromise);
    appState.turnHint = waitingForExtract
      ? (de ? "Wartet kurz auf Dossier-Update…" : "Waiting for dossier update…")
      : "Thinking…";
    setLoading(true, "turn");
    voice.stopMicCapture({ keepPhase: true });
    voice.stopSpeak();
    voice.beginSpeakStream?.();
    voice.setVoicePhase("thinking");
    let thinking = showThinkingBubble(appState.turnHint);

    // If the previous turn is still updating the dossier in the background, WAIT for it to
    // finish instead of aborting it — so the new reply sees the freshly updated dossier!
    if (inFlightExtractPromise) {
      try { await inFlightExtractPromise; } catch { /* ignore */ }
      if (nav.isStale(seq, id)) {
        removeThinking(thinking);
        nav.turnBusy = false;
        setLoading(false);
        return;
      }
      session = activeSession() || session;
      ensureTrailingUser(session, trimmed);
      appState.turnHint = "Thinking…";
      thinking = showThinkingBubble(appState.turnHint);
    }

    showProcessBusy("turn", id, t("thinking", session.language || "de"));
    turnAbort = new AbortController();
    const myAbort = turnAbort;
    let unlockedForSpeak = false;
    let bubble = null;
    let resolveExtractDone;
    inFlightExtractPromise = new Promise((res) => { resolveExtractDone = res; });
    const maybeShowIntakeEnd = (d) => {
      if (d?.offer_end || isDossierComplete(d?.session)) showIntakeEnd();
    };
    const unlockAfterReply = (d) => {
      if (unlockedForSpeak || nav.isStale(seq, id)) return;
      unlockedForSpeak = true;
      appState.turnHint = null;
      nav.turnBusy = false;
      if (appState.sessionId === id) setLoading(false);
      showProcessBusy("extract", id, t("updatingDossier", session.language || "de"));
      if (d?.session) {
        sessions.applySessionToList(d.session);
        sessions.patchActiveSession(d.session);
      }
      if (bubble && d?.reply) bubble.textContent = d.reply;
      maybeShowIntakeEnd(d);
      if (typeof voice.endSpeakStream === "function") voice.endSpeakStream(d.reply || "");
      else void voice.speak(d.reply || "");
    };
    try {
      await modelManager.ensureLoaded("llm");
      if (myAbort.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const prepared = await api(`/api/sessions/${id}/turn/prepare`, {
        method: "POST",
        body: JSON.stringify({ text: trimmed }),
        signal: myAbort.signal,
      });
      if (nav.isStale(seq, id)) return;
      // Do NOT patchActiveSession(prepared.session) here — prepared.session only has the user
      // line and would trigger renderChat(), wiping the live thinking/streaming bubble!
      if (prepared?.session) {
        sessions.applySessionToList(prepared.session);
      }
      const stripMarks = (raw) => (raw || "")
        .replace(/\n?\s*\[\[\s*dossier\s*:\s*(yes|no)\s*\]\]\s*$/i, "")
        .replace(/\n?\s*\[\[\s*intake\s*:\s*end\s*\]\]\s*$/i, "")
        .trim();
      let streamed = "";
      let committedAfterReply = false;
      const { raw_reply, raw_extract } = await modelManager.runTurn(prepared, {
        onReplyDelta: (chunk) => {
          if (nav.isStale(seq, id) || myAbort.signal.aborted) return;
          streamed += chunk;
          voice.pushSpeakStream?.(chunk);
          if (!bubble) {
            appState.turnHint = null;
            bubble = promoteThinking(thinking, streamed);
            thinking = null;
          } else if (!unlockedForSpeak) {
            bubble.textContent = streamed;
          }
          chatScroll.scrollTop = chatScroll.scrollHeight;
        },
        onReplyDone: async (replyRaw) => {
          if (nav.isStale(seq, id) || myAbort.signal.aborted) return;
          const fullRaw = (replyRaw || streamed).trim();
          const spoken = stripMarks(fullRaw) || fullRaw;
          if (!bubble && thinking) {
            bubble = promoteThinking(thinking, spoken);
            thinking = null;
          } else if (bubble) {
            bubble.textContent = spoken;
          }
          // Persist the assistant reply on disk BEFORE Call #2 (extract) starts, so
          // refreshing or slow extract never leaves the user message unanswered.
          let replySaved = null;
          if (fullRaw) {
            try {
              replySaved = await api(`/api/sessions/${id}/turn/reply`, {
                method: "POST",
                body: JSON.stringify({ raw_reply: fullRaw }),
                signal: myAbort.signal,
              });
            } catch {
              /* commit will still save if this failed */
            }
          }
          unlockAfterReply({
            reply: replySaved?.reply || spoken,
            needs_extract: true,
            session: replySaved?.session,
            offer_end: replySaved?.offer_end,
          });
          showProcessBusy("extract", id, t("updatingDossier", session.language || "de"));
          if (voice.getPhase() !== "speaking") {
            voice.setStatus(t("updatingDossier", session.language || "de"));
          }
        },
        onPhase: (phase) => {
          if (phase === "extract") {
            showProcessBusy("extract", id, t("updatingDossier", session.language || "de"));
            if (voice.getPhase() !== "speaking") {
              voice.setStatus(t("updatingDossier", session.language || "de"));
            }
          }
        },
      });
      if (myAbort.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const spokenReply = stripMarks(raw_reply) || raw_reply;
      if (!unlockedForSpeak) {
        if (!bubble && thinking) {
          bubble = promoteThinking(thinking, spokenReply);
          thinking = null;
        } else if (bubble) {
          bubble.textContent = spokenReply;
        }
        unlockAfterReply({ reply: spokenReply, needs_extract: true });
      }
      void committedAfterReply;
      const data = await api(`/api/sessions/${id}/turn/commit`, {
        method: "POST",
        body: JSON.stringify({
          raw_reply,
          raw_extract,
          text: trimmed,
        }),
        signal: myAbort.signal,
      });
      if (nav.isStale(seq, id)) return;
      clearTurnError();
      sessions.applySessionToList(data.session);
      sessions.patchActiveSession(data.session);
      void sessions.refreshPicker();
      if (bubble && data?.session) syncBubbleWarning(bubble, data.session);
      maybeShowIntakeEnd(data);
      syncIntakeEnd(data.session);
      hideProcessBusy();
    } catch (err) {
      removeThinking(thinking);
      hideProcessBusy();
      if (turnAbort !== myAbort && turnAbort !== null) return;
      if (!nav.isStale(seq, id)) {
        const aborted = err?.name === "AbortError"
          || /aborted|aborterror/i.test(String(err?.message || err));
        const message = aborted
          ? "Reply interrupted"
          : String(err.message || err).slice(0, 140);
        voice.setVoicePhase("idle", message);
        ensureTrailingUser(session, trimmed);
        setTurnError({ sessionId: id, text: trimmed, message });
      }
    } finally {
      resolveExtractDone?.();
      if (turnAbort === myAbort) {
        turnAbort = null;
        inFlightExtractPromise = null;
        appState.turnHint = null;
        if (!unlockedForSpeak) {
          nav.turnBusy = false;
          if (appState.sessionId === id) setLoading(false);
          if (voice.getPhase() === "thinking" && appState.sessionId === id) {
            voice.setVoicePhase("idle");
          }
        }
        if (appState.processBusy?.sessionId === id) hideProcessBusy();
      }
    }
  }

  async function sendTextServer(text, { isRetry = false } = {}) {
    const trimmed = (text || "").trim();
    const id = activeId();
    let session = activeSession();
    if (isPicker() || !id || !session || !trimmed || nav.turnBusy || appState.loading) return;
    clearTurnError();
    const seq = nav.seq;
    nav.turnBusy = true;
    // Persist user line before paint so renderChat order is: … → Du → thinking bubble.
    ensureTrailingUser(session, trimmed);
    hideIntakeEnd();
    // The dossier update of the previous turn runs on the server in the background: the next reply
    // does NOT wait for it (STT, thinking and TTS stay free). Updates queue up server-side.
    appState.turnHint = "Thinking…";
    setLoading(true, "turn");
    voice.stopMicCapture({ keepPhase: true });
    voice.stopSpeak();
    voice.beginSpeakStream?.();
    voice.setVoicePhase("thinking");
    let thinking = showThinkingBubble(appState.turnHint);
    const myGen = (turnGen += 1);
    const newerTurnRunning = () => myGen !== turnGen;

    // Header: Thinking… first; Switching to Updating dossier… only after reply unlock.
    showProcessBusy("turn", id, t("thinking", session.language || "de"));
    turnAbort = new AbortController();
    const myAbort = turnAbort;
    let unlockedForSpeak = false;
    let bubble = null;
    let resolveExtractDone;
    inFlightExtractPromise = new Promise((res) => { resolveExtractDone = res; });
    const setTurnHint = (msg) => {
      appState.turnHint = msg;
      const hint = document.getElementById("composerHint");
      if (hint) {
        hint.hidden = false;
        hint.dataset.live = "1";
        hint.textContent = msg;
      }
      voice.setStatus(msg);
      if (thinking) setThinkingLabel(thinking, msg);
      if (appState.processBusy?.sessionId === id && appState.processBusy.kind === "turn") {
        showProcessBusy("turn", id, msg);
      }
    };
    /** Show end CTAs when the model marked [[intake:end]] or dossier is complete after update. */
    const maybeShowIntakeEnd = (d) => {
      if (d?.offer_end || isDossierComplete(d?.session)) showIntakeEnd();
    };
    /** Reply ready: unlock mic; finish TTS stream (sentences may already be playing). */
    const unlockAfterReply = (d) => {
      if (unlockedForSpeak || nav.isStale(seq, id)) return;
      unlockedForSpeak = true;
      appState.turnHint = null;
      nav.turnBusy = false;
      if (appState.sessionId === id) setLoading(false);
      // Keep header busy if extract follows; otherwise clear.
      if (d?.needs_extract) {
        showProcessBusy("extract", id, t("updatingDossier", session.language || "de"));
      } else {
        hideProcessBusy();
      }
      if (d?.session) {
        sessions.applySessionToList(d.session);
        sessions.patchActiveSession(d.session);
      }
      if (bubble && d?.reply) bubble.textContent = d.reply;
      if (bubble && d?.session) syncBubbleWarning(bubble, d.session);
      maybeShowIntakeEnd(d);
      if (typeof voice.endSpeakStream === "function") voice.endSpeakStream(d.reply || "");
      else void voice.speak(d.reply || "");
    };
    try {
      let streamed = "";
      // Reply deltas → live TTS chunks; extract status → topbar process banner.
      const data = await apiStream(
        `/api/sessions/${id}/turn/stream`,
        { text: trimmed },
        (name, d) => {
          if (nav.isStale(seq, id)) return;
          if (name === "reply") {
            if (!bubble && thinking) {
              bubble = promoteThinking(thinking, d.reply || streamed);
              thinking = null;
            } else if (bubble && d.reply) {
              bubble.textContent = d.reply;
            }
            unlockAfterReply(d);
            return;
          }
          if (name === "status") {
            if (d.phase === "extract") {
              if (newerTurnRunning()) return; // the newer turn owns the banner and the status line
              const msg = d.message || t("updatingDossier", session.language || "de");
              showProcessBusy("extract", id, msg);
              // Do NOT overwrite voiceStatus if TTS is currently speaking!
              if (voice.getPhase() !== "speaking") voice.setStatus(msg);
              return;
            }
            // Reply phase: keep Thinking… until tokens promote the bubble.
            if (!unlockedForSpeak) {
              const msg = d.message || t("thinking", session.language || "de");
              setTurnHint(msg);
              showProcessBusy("turn", id, msg);
            }
            return;
          }
          if (name !== "delta") return;
          streamed += d.text;
          voice.pushSpeakStream?.(d.text);
          if (!bubble) {
            appState.turnHint = null;
            bubble = promoteThinking(thinking, streamed);
            thinking = null;
          } else if (!unlockedForSpeak) {
            bubble.textContent = streamed;
          }
          chatScroll.scrollTop = chatScroll.scrollHeight;
        },
        { signal: turnAbort.signal },
      );
      if (nav.isStale(seq, id)) {
        removeThinking(thinking);
        hideProcessBusy();
        return;
      }
      if (newerTurnRunning()) {
        // Only this turn's dossier update was still running; the founder already talks on.
        // The newer turn paints the session when it finishes (it includes this update).
        return;
      }
      if (!data.session || data.session.id !== id) {
        removeThinking(thinking);
        hideProcessBusy();
        voice.setVoicePhase("idle", "Reply context mismatch — please reload the session");
        ensureTrailingUser(session, trimmed);
        setTurnError({ sessionId: id, text: trimmed, message: "Reply context mismatch" });
        return;
      }
      clearTurnError();
      sessions.applySessionToList(data.session);
      sessions.patchActiveSession(data.session);
      void sessions.refreshPicker();
      // Fallback if an older server omitted the mid-stream `reply` event.
      if (!unlockedForSpeak) unlockAfterReply(data);
      if (bubble && data?.session) syncBubbleWarning(bubble, data.session);
      // Always re-evaluate END after dossier extract finishes (`done` has post-extract session).
      maybeShowIntakeEnd(data);
      syncIntakeEnd(data.session);
      hideProcessBusy();
    } catch (err) {
      removeThinking(thinking);
      // A newer turn already talks on: its UI (banner, phase) is not ours to clear.
      if (newerTurnRunning()) return;
      hideProcessBusy();
      // Superseded by a newer send — leave UI to the new turn.
      if (turnAbort !== myAbort && turnAbort !== null) return;
      if (!nav.isStale(seq, id)) {
        const aborted = err?.name === "AbortError"
          || /aborted|aborterror/i.test(String(err?.message || err));
        const message = aborted
          ? "Reply interrupted"
          : String(err.message || err).slice(0, 140);
        voice.setVoicePhase("idle", message);
        ensureTrailingUser(session, trimmed);
        setTurnError({ sessionId: id, text: trimmed, message });
      }
    } finally {
      resolveExtractDone?.();
      if (turnAbort === myAbort) {
        turnAbort = null;
        inFlightExtractPromise = null;
        appState.turnHint = null;
        if (!unlockedForSpeak) {
          nav.turnBusy = false;
          if (appState.sessionId === id) setLoading(false);
          if (voice.getPhase() === "thinking" && appState.sessionId === id) {
            voice.setVoicePhase("idle");
          }
        }
        // Clear banner if this turn still owns it (abortTurn may have cleared already).
        if (appState.processBusy?.sessionId === id) hideProcessBusy();
      }
    }
  }

  /** Typed input joins the same pipeline as voice: it ends in sendText() too. */
  function submitInput() {
    const t = textInput.value;
    textInput.value = "";
    textInput.style.height = "";
    voice.stopMicCapture({ keepPhase: true });
    sendText(t);
  }

  /** [Weiter fragen]: ask the backend to generate one more follow-up question and speak it. */
  async function continueAsking() {
    const id = activeId();
    const session = activeSession();
    if (isPicker() || !id || !session || nav.turnBusy || appState.loading) return;
    hideIntakeEnd({ userDismiss: true });
    const seq = nav.seq;
    nav.turnBusy = true;
    appState.turnHint = "Thinking…";
    setLoading(true, "turn");
    showProcessBusy("turn", id, t("thinking", session.language || "de"));
    voice.stopSpeak();
    voice.setVoicePhase("thinking");
    const thinking = showThinkingBubble(appState.turnHint);
    try {
      let data;
      if (isBrowserLlm(prefs.llm)) {
        await modelManager.ensureLoaded("llm");
        const prepared = await api(`/api/sessions/${id}/continue/prepare`, {
          method: "POST",
          body: "{}",
        });
        const raw_reply = await modelManager.generateOnce(
          prepared.reply_system,
          prepared.reply_user,
          prepared.reply_max_tokens || 400,
        );
        data = await api(`/api/sessions/${id}/continue/commit`, {
          method: "POST",
          body: JSON.stringify({ raw_reply }),
        });
      } else {
        data = await api(`/api/sessions/${id}/continue`, { method: "POST", body: "{}" });
      }
      if (nav.isStale(seq, id)) return;
      removeThinking(thinking);
      if (data?.session) {
        sessions.applySessionToList(data.session);
        sessions.patchActiveSession(data.session);
      }
      if (data?.reply) void voice.speak(data.reply);
    } catch (err) {
      removeThinking(thinking);
      voice.setVoicePhase("idle", String(err?.message || err).slice(0, 120));
    } finally {
      appState.turnHint = null;
      nav.turnBusy = false;
      if (appState.sessionId === id) setLoading(false);
      hideProcessBusy();
    }
  }

  /** [Sprechen]: mic only while a session is open (home starts via #confirmNewBtn). */
  async function onSpeakClick() {
    if (isPicker() || !activeId() || !activeSession()) return;
    voice.onMicClick();
  }

  function bind({ onEndClose } = {}) {
    // Mic may be re-created by placeSpeakDock — listen on chatScroll (delegation).
    chatScroll.addEventListener("click", (e) => {
      if (e.target.closest("#micBtn")) void onSpeakClick();
    });
    document.getElementById("sendBtn").addEventListener("click", submitInput);
    textInput.addEventListener("keydown", (e) => {
      // Enter sends; Shift+Enter keeps a newline for long STT / typed answers.
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitInput(); }
    });
    textInput.addEventListener("input", () => {
      textInput.style.height = "auto";
      textInput.style.height = `${Math.min(textInput.scrollHeight, 192)}px`;
    });
    qaList.addEventListener("click", (e) => {
      const btn = e.target.closest('[data-act="retry-turn"]');
      if (!btn) return;
      const text = btn.dataset.text || appState.turnError?.text || "";
      void sendText(text, { isRetry: true });
    });
    document.getElementById("intakeEndContinue")?.addEventListener("click", () => {
      void continueAsking();
    });
    document.getElementById("intakeEndFinalize")?.addEventListener("click", () => {
      document.getElementById("finalizeBtn")?.click();
    });
    document.getElementById("intakeEndClose")?.addEventListener("click", () => {
      if (onEndClose) void onEndClose();
      else document.getElementById("finalizeBtn")?.click();
    });
  }

  return {
    sendText, renderChat, bind, abortTurn, beginExtractWait,
    placeSpeakDock, hideIntakeEnd, syncIntakeEnd,
  };
}
