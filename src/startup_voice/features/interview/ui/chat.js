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
 * BUTTON -> HANDLER -> BACKEND   (backend docs: features/interview/routes.py)
 * ==========================================================================
 *   [Senden]  #sendBtn, [Enter] in #textInput  -> submitInput() -> sendText()
 *   [Sprechen] #micBtn                         -> voice.onMicClick (STT only) -> onTranscript
 *                                                 -> sendText()
 */

import { apiStream } from "../../shared/api.js";
import { esc } from "../../shared/format.js";
import { activeId, activeSession, appState, isPicker, nav, setLoading } from "../../shared/state.js";

/**
 * @param {{voice: object, sessions: object}} deps
 *   voice    - createVoice() result (STT/TTS)
 *   sessions - createSessions() result (patchActiveSession, refreshPicker, ...)
 */
export function createChat({ voice, sessions }) {
  const qaList = document.getElementById("qaList");
  const chatScroll = document.getElementById("chatScroll");
  const textInput = document.getElementById("textInput");

  /** Append one chat bubble; returns its wrapper element. */
  function addQa(role, text) {
    const wrap = document.createElement("div");
    wrap.className = "team-qa";
    const body = esc(text);
    wrap.innerHTML = role === "assistant"
      ? `<div class="team-qa__q">${body}</div>`
      : `<div class="team-qa__a"><div class="team-qa__a-avatar user">Du</div><div class="team-qa__a-bubble user-bubble"><p>${body}</p></div></div>`;
    qaList.appendChild(wrap);
    chatScroll.scrollTop = chatScroll.scrollHeight;
    return wrap;
  }

  function renderChat(session) {
    qaList.innerHTML = "";
    if (!session) return;
    (session.messages || []).forEach((m) =>
      addQa(m.role === "assistant" ? "assistant" : "user", m.content));
  }

  /**
   * ╔════════════════════════════════════════════════════════════════════════╗
   * ║ sendText(text) - THE ONE PLACE A USER MESSAGE GOES TO THE BACKEND/LLM  ║
   * ╚════════════════════════════════════════════════════════════════════════╝
   *
   *   1. Guard      : ignore empty text, picker view, or a turn already in flight.
   *   2. Optimistic : paint the user's bubble immediately.
   *   3. Stream     : POST /api/sessions/{id}/turn/stream, read SSE events:
   *                     event: delta -> append `text` to a growing assistant bubble
   *                     event: done  -> final payload { session, reply }
   *                     event: error -> apiStream() throws -> caught below
   *   4. Reconcile  : replace local state with the server's `session`
   *                   (source of truth: messages, dossier slots, scores).
   *   5. Speak      : voice.speak(reply) -> POST /api/tts, only AFTER the full text arrived.
   *
   * Stale guard: if the user switched conversation mid-request (nav.isStale), the late
   * response is dropped instead of being painted into the wrong chat.
   */
  async function sendText(text) {
    const trimmed = (text || "").trim();
    const id = activeId();
    const session = activeSession();
    if (isPicker() || !id || !session || !trimmed || nav.turnBusy || appState.loading) return;
    const seq = nav.seq;
    nav.turnBusy = true;
    setLoading(true, "turn");
    voice.stopMicCapture({ keepPhase: true });
    voice.stopSpeak();
    voice.setVoicePhase("thinking");
    addQa("user", trimmed);
    try {
      let streamed = "";
      let bubble = null;
      // ──► BACKEND/LLM CALL. Everything upstream (mic, STT) only produced `trimmed`.
      const data = await apiStream(`/api/sessions/${id}/turn/stream`, { text: trimmed }, (name, d) => {
        if (name !== "delta" || nav.isStale(seq, id)) return;
        streamed += d.text;
        if (!bubble) bubble = addQa("assistant", streamed).querySelector(".team-qa__q");
        else bubble.textContent = streamed;
        chatScroll.scrollTop = chatScroll.scrollHeight;
      });
      if (nav.isStale(seq, id)) return;
      if (!data.session || data.session.id !== id) {
        voice.setVoicePhase("idle", "Antwort-Kontext stimmt nicht — bitte Session neu laden");
        return;
      }
      sessions.applySessionToList(data.session);
      // Re-paint chat from the server session (user + assistant); no second addQa.
      sessions.patchActiveSession(data.session);
      sessions.refreshPicker();
      // ──► BACK INTO voice.js: read the finished reply aloud (TTS).
      await voice.speak(data.reply);
    } catch (err) {
      if (!nav.isStale(seq, id)) {
        voice.setVoicePhase("idle", String(err.message || err).slice(0, 140));
      }
    } finally {
      nav.turnBusy = false;
      if (appState.sessionId === id) setLoading(false);
      if (voice.getPhase() === "thinking" && appState.sessionId === id) voice.setVoicePhase("idle");
    }
  }

  /** Typed input joins the same pipeline as voice: it ends in sendText() too. */
  function submitInput() {
    const t = textInput.value;
    textInput.value = "";
    voice.stopMicCapture({ keepPhase: true });
    sendText(t);
  }

  function bind() {
    // [Sprechen] - STT only; the transcript comes back through onTranscript -> sendText.
    document.getElementById("micBtn").addEventListener("click", voice.onMicClick);
    // [Senden] and [Enter]
    document.getElementById("sendBtn").addEventListener("click", submitInput);
    textInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submitInput(); }
    });
  }

  return { sendText, renderChat, bind };
}
