/** Thin JSON fetch wrapper for the backend API. */

export async function api(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * POST a JSON body and consume the Server-Sent Events (SSE) reply.
 *
 * Why not the browser's `EventSource`? It can only issue GET requests with no
 * body. Our turn endpoint is a POST carrying `{ text }`, so we read the response
 * stream by hand with fetch + ReadableStream and parse the SSE framing ourselves.
 *
 * Wire format (produced by features/interview/routes.py `turn_stream`). Events are separated by a
 * blank line; each has an `event:` name and a JSON `data:` payload:
 *
 *     event: status                -> onEvent("status", { phase, message })
 *     data: {"phase": "extract"|"reply", "message": "..."}
 *
 *     event: delta                 -> onEvent("delta", { text })   (many)
 *     data: {"text": "Danke. "}
 *
 *     event: reply                 -> onEvent("reply", { reply, session, needs_extract })
 *     data: {…}   spoken text ready — UI may TTS + unlock mic before extract
 *
 *     event: done                  -> onEvent("done", { session, reply, needs_extract })  (once)
 *     data: {"session": {...}, "reply": "..."}
 *
 *     event: error                 -> THROWS Error(message)         (instead of done)
 *     data: {"message": "..."}
 *
 * Used by: interview/ui/chat.js `sendText()`. Transport only — no chat/LLM logic.
 *
 * @param {string} path                       e.g. `/api/sessions/${id}/turn/stream`
 * @param {object} body                       JSON-serialisable request body
 * @param {(name: string, data: any) => void} onEvent  called per parsed event
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<any>} the payload of the `done` event
 * @throws {Error} on HTTP error, an `error` event, abort, or a stream that ends without `done`
 */
export async function apiStream(path, body, onEvent, opts = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(await res.text());
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = null;
  const dispatch = (block) => {
    let name = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const data = JSON.parse(dataLines.join("\n"));
    if (name === "error") throw new Error(data.message || "stream error");
    if (name === "done") done = data;
    onEvent(name, data);
  };
  try {
    for (;;) {
      const { value, done: eof } = await reader.read();
      buf += decoder.decode(value || new Uint8Array(), { stream: !eof });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        dispatch(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
      if (eof) break;
    }
  } catch (err) {
    try { await reader.cancel(); } catch { /* ignore */ }
    throw err;
  }
  if (buf.trim()) dispatch(buf);
  if (!done) throw new Error("stream ended without result");
  return done;
}
