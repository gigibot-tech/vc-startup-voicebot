/**
 * Plain-language status lines for the Tech settings (and the top banner while a model loads).
 * Pure functions: the page decides where to show them. The point: a model that is still loading
 * must never look like "nothing works" - speech recognition is independent of the reply model.
 */

const pick = (lang, de, en) => (String(lang || "de").toLowerCase().startsWith("en") ? en : de);
const pct = (n) => `${Math.max(0, Math.min(100, Math.round(Number(n) || 0)))} %`;

export const isBrowserLlm = (llm) => llm === "granite-3b" || llm === "gemma-3n-e2b" || llm === "transformers";

/** Line under the reply-model dropdown. */
export function describeLlm({ llm, state = "unloaded", progress = 0, lang = "de" }) {
  if (!isBrowserLlm(llm)) {
    return pick(lang,
      "Die Antworten kommen vom Server. Im Browser wird hier nichts geladen.",
      "Replies come from the server. Nothing is loaded in the browser here.");
  }
  switch (state) {
    case "checking_cache":
      return pick(lang, "Prüfe, ob das Modell schon im Browser liegt …", "Checking whether the model is already in the browser …");
    case "downloading":
      return pick(lang,
        `Das Modell lädt gerade (${pct(progress)}). Du kannst schon sprechen – die Spracherkennung läuft; die Antwort kommt, sobald das Modell bereit ist.`,
        `The model is downloading (${pct(progress)}). You can already talk - speech recognition works; the reply comes once the model is ready.`);
    case "warming_up":
      return pick(lang,
        "Das Modell wird für deine Grafikkarte vorbereitet. Sprechen geht schon, die Antwort kommt gleich.",
        "The model is being prepared for your graphics card. You can talk already, the reply follows shortly.");
    case "cached_idle":
      return pick(lang,
        "Das Modell ist gespeichert, aber noch nicht im Speicher. Es wird bei der ersten Antwort geladen – oder wähle oben ein anderes Modell.",
        "The model is saved but not in memory yet. It loads with the first reply - or pick another model above.");
    case "ready":
    case "running":
      return pick(lang,
        "Modell bereit: Antworten und Dossier-Update laufen auf deinem Rechner.",
        "Model ready: replies and dossier updates run on your computer.");
    case "error":
      return pick(lang,
        "Das Modell konnte nicht geladen werden. Versuche es erneut oder wähle oben ein anderes Modell.",
        "The model could not be loaded. Try again or pick another model above.");
    default:
      return pick(lang,
        "Noch kein Modell geladen. Sprechen und Spracherkennung funktionieren trotzdem – für Antworten lädt der Browser das Modell einmalig (ca. 2 GB), oder du wählst oben ein anderes.",
        "No model loaded yet. Talking and speech recognition still work - for replies the browser downloads the model once (about 2 GB), or you pick another one above.");
  }
}

/** Line under the speech-recognition dropdown. */
export function describeStt({ stt, state = "unloaded", progress = 0, lang = "de" }) {
  if (stt === "whisper") {
    if (state === "downloading") {
      return pick(lang, `Whisper lädt (${pct(progress)}). Danach hört dein Browser lokal zu.`, `Whisper is downloading (${pct(progress)}). Afterwards your browser listens locally.`);
    }
    if (state === "ready" || state === "running" || state === "cached_idle") {
      return pick(lang, "Whisper ist bereit – deine Stimme verlässt deinen Rechner nicht.", "Whisper is ready - your voice never leaves your computer.");
    }
    if (state === "error") {
      return pick(lang, "Whisper konnte nicht geladen werden. Wechsle auf „Browser (Web Speech)“.", "Whisper could not be loaded. Switch to “Browser (Web Speech)”.");
    }
    return pick(lang,
      "Whisper ist gewählt und wird beim Start des Gesprächs geladen (einmalig ca. 250 MB).",
      "Whisper is selected and loads when the conversation starts (about 250 MB once).");
  }
  if (stt === "elevenlabs" || stt === "deepgram") {
    const name = stt === "elevenlabs" ? "ElevenLabs" : "Deepgram";
    return pick(lang, `Aktiv: Cloud-Erkennung (${name}). Dein Audio geht dafür an den Anbieter.`, `Active: cloud recognition (${name}). Your audio is sent to the provider.`);
  }
  return pick(lang,
    "Aktiv: Erkennung durch deinen Browser (Web Speech). Für mehr Privatsphäre wechsle auf Whisper.",
    "Active: recognition by your browser (Web Speech). For more privacy switch to Whisper.");
}

/** Top banner while a model downloads / warms up. null = nothing to show. */
export function describeModelBanner({ slot, state, progress = 0, lang = "de" }) {
  if (state !== "downloading" && state !== "warming_up" && state !== "checking_cache") return null;
  if (slot === "llm") {
    return state === "downloading"
      ? pick(lang, `Antwort-KI lädt ${pct(progress)} – du kannst schon sprechen`, `Reply AI downloading ${pct(progress)} - you can already talk`)
      : pick(lang, "Antwort-KI wird vorbereitet – du kannst schon sprechen", "Reply AI getting ready - you can already talk");
  }
  if (slot === "whisper") {
    return pick(lang, `Spracherkennung (Whisper) lädt ${pct(progress)}`, `Speech recognition (Whisper) downloading ${pct(progress)}`);
  }
  return pick(lang, `Stimme lädt ${pct(progress)}`, `Voice downloading ${pct(progress)}`);
}
