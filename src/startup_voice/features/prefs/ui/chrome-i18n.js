/** Chrome UI strings follow #langSel (DE/EN). Interview speech language uses the same switch. */

const STR = {
  de: {
    newChat: "Neues Gespräch",
    startNewChat: "Neues Gespräch starten",
    settings: "Einstellungen",
    speak: "Sprechen",
    send: "Senden",
    stop: "Stopp",
    chooseSession: "Gespräch wählen",
    chooseSessionLead: "Bestehendes Gespräch öffnen oder neu starten — ohne sofort Sprache.",
    heroTitle: "Ihr Startup",
    heroSub: "im Erstgespräch",
    sessionHintPick: "Gespräch links wählen oder neu starten.",
    dossierMetaNone: "Kein Gespräch geladen",
    dossierLive: "Live",
    dossierEm: "Dossier",
    finalize: "Dossier abschließen",
    clearDossier: "Dossier leeren",
    deleteSession: "Gespräch & Dossier löschen",
    deleteConfirm: "Gespräch und Dossier unwiderruflich löschen? Beides ist danach weg.",
    saveCatalog: "Katalog speichern",
    defaults: "Standard",
    questionCatalog: "Fragenkatalog",
    intakeEndCopy: "Dossier bereit — weiter fragen, Version speichern oder Gespräch beenden.",
    continue: "Weiter fragen",
    continueAsking: "Weiter fragen",
    saveVersion: "Version speichern",
    endChat: "Speichern & Beenden",
    finalizeDossier: "Dossier abschließen",
    writeReply: "Antwort schreiben…",
    extractDossier: "Dossier extrahieren",
    carryDossier: "Dossier mitnehmen",
    carryConfirm: "Neues leeres Gespräch mit diesem Dossier starten? Der bisherige Chat bleibt erhalten.",
    updatingDossier: "Dossier wird aktualisiert…",
    thinking: "Thinking…",
    processingReply: "Thinking…",
    loadingSession: "Gespräch wird geladen…",
    finalizingDossier: "Dossier wird abgeschlossen…",
    sessionPick: "Gespräch wählen…",
    noSessions: "Noch keine Gespräche",
    langLabel: "Sprache für STT/TTS und Interview (aktiv + neu)",
    interviewLang: "Interview-Sprache",
    publishBtn: "Öffentlich teilen…",
    homeBoardLead: "Ideen, die Gründer:innen öffentlich geteilt haben.",
    homeBoardEmpty: "Noch nichts veröffentlicht. Du kannst dein Dossier später unter „Öffentlich teilen…“ veröffentlichen.",
    homeBoardOpen: "Ganzen Board öffnen →",
    // Settings panel (founder-friendly)
    prefsTalkTitle: "Wie möchtest du sprechen?",
    modeClassicTitle: "Antippen & sprechen",
    modeClassicDesc: "Tippe auf „Sprechen“, erzähl, tippe auf „Stopp“. Wie eine Sprachnachricht.",
    modeLiveTitle: "Live-Gespräch",
    modeLiveDesc: "Wie ein Telefonat: einfach reden, jederzeit unterbrechen.",
    modeNotSetUp: "Noch nicht eingerichtet",
    autoListenTitle: "Nach der Antwort gleich weiter zuhören",
    autoListenDesc: "Du musst nicht jedes Mal neu auf „Sprechen“ tippen.",
    langNote: "Die Sprache (Deutsch / Englisch) stellst du oben rechts ein.",
    prefsVoiceTitle: "Stimme & Dossier",
    voiceOnTitle: "Antworten laut vorlesen",
    voiceOnDesc: "Aus = du liest die Antworten nur im Chat.",
    cuesTitle: "Signaltöne im Gespräch",
    cuesDesc: "Kurzer Ton, wenn du dran bist, wenn deine Antwort angekommen ist und wenn das Gespräch endet.",
    speedLabel: "Sprechtempo",
    speedSlow: "Langsam",
    speedSlower: "Etwas langsamer",
    speedNormal: "Normal",
    speedFaster: "Etwas schneller",
    speedFast: "Schnell",
    autoResolveLabel: "Dossier-Änderungen automatisch übernehmen",
    autoResolveHelp: "Wie sicher die KI sein muss, damit sie eine Angabe im Dossier ohne Rückfrage ändert",
    autoResolve50: "Fast immer",
    autoResolve70: "Wenn ziemlich sicher",
    autoResolve75: "Wenn sicher (empfohlen)",
    autoResolve85: "Nur wenn sehr sicher",
    autoResolve95: "Nur wenn fast eindeutig",
    autoResolveOff: "Nie – ich prüfe alles selbst",
    autoResolveNote: "Wenn sich die KI unsicher ist, fragt sie dich, bevor sie etwas im Dossier ändert.",
    techTitle: "Technik & Feintuning",
    techSub: "Für dein Tech-Team – musst du nicht anfassen",
    voiceModeLabel: "Sprachmodus",
    voiceModeHelp: "Klassisch: Du tippst auf den Mikrofon-Knopf, sprichst und sendest. Live-Gespräch: freihändig wie ein Telefonat – du kannst jederzeit dazwischenreden. Live braucht einen kleinen Sprach-Dienst (LiveKit-Worker, siehe README).",
    sttLabel: "Spracherkennung (STT)",
    sttHelp: "Standard: Der Browser erkennt deine Sprache selbst (Web Speech) – kostenlos, nichts zu laden. Hier kannst du auf ein lokales Modell (Whisper) wechseln: privater, es läuft ganz auf deinem Rechner, lädt aber einmalig ca. 250 MB. Im Live-Gespräch hört dann dein Browser zu; der Sprach-Dienst spricht nur.",
    sttOptBrowser: "Browser (Web Speech) – Standard",
    sttOptWhisper: "Whisper – lokales Modell im Browser",
    llmLabel: "Antwort-KI (LLM)",
    llmHelp: "Die KI, die auf deine Antworten reagiert und das Dossier füllt. „Server“ läuft auf dem Server, „Browser“ läuft per WebGPU auf deinem Rechner (lädt einmalig ein Modell, danach privat). Antwort und Dossier-Update nutzen dasselbe Modell. Solange noch kein Modell geladen ist, kannst du trotzdem sprechen – die Spracherkennung läuft unabhängig davon.",
    llmOptBrowser1: "LFM3 · 1.7B (im Browser, WebGPU)",
    llmOptBrowser2: "Gemma 3n · E2B Nano (im Browser, WebGPU)",
    llmOptBrowser3: "Granite 4 · 3B (im Browser, WebGPU)",
    ttsLabel: "Sprachausgabe (TTS)",
    ttsOptLocal: "Stimme im Browser (lädt einmalig, Standard)",
    ttsOptBrowser: "Stimme des Betriebssystems (Web Speech)",
  },
  en: {
    newChat: "New chat",
    startNewChat: "Start new chat",
    settings: "Settings",
    speak: "Speak",
    send: "Send",
    stop: "Stop",
    chooseSession: "Choose a session",
    chooseSessionLead: "Open an existing chat or start a new one — without starting voice immediately.",
    heroTitle: "Your startup",
    heroSub: "in the first call",
    sessionHintPick: "Choose a session or start a new one.",
    dossierMetaNone: "No session loaded",
    dossierLive: "Live",
    dossierEm: "dossier",
    finalize: "Finalize dossier",
    clearDossier: "Clear dossier",
    deleteSession: "Delete chat & dossier",
    deleteConfirm: "Permanently delete this chat and its dossier? Both are removed.",
    saveCatalog: "Save catalog",
    defaults: "Defaults",
    questionCatalog: "Question catalog",
    intakeEndCopy: "Dossier ready — keep asking, save a version, or end the chat.",
    continue: "Continue asking",
    continueAsking: "Continue asking",
    saveVersion: "Save version",
    endChat: "Save & End",
    finalizeDossier: "Finalize dossier",
    writeReply: "Write a reply…",
    extractDossier: "Extract dossier",
    carryDossier: "Carry dossier",
    carryConfirm: "Start a new empty conversation with this dossier? The current chat stays as it is.",
    updatingDossier: "Updating dossier…",
    thinking: "Thinking…",
    processingReply: "Thinking…",
    loadingSession: "Loading session…",
    finalizingDossier: "Finalizing dossier…",
    sessionPick: "Choose session…",
    noSessions: "No sessions yet",
    langLabel: "Language for STT/TTS and interview (active + new sessions)",
    interviewLang: "Interview language",
    publishBtn: "Share publicly…",
    homeBoardLead: "Ideas founders chose to share.",
    homeBoardEmpty: "Nothing published yet. You can publish your dossier later with “Share publicly…”.",
    homeBoardOpen: "Open the full board →",
    // Settings panel (founder-friendly)
    prefsTalkTitle: "How do you want to talk?",
    modeClassicTitle: "Tap & talk",
    modeClassicDesc: "Tap “Speak”, tell your story, tap “Stop”. Like a voice message.",
    modeLiveTitle: "Live call",
    modeLiveDesc: "Like a phone call: just talk, interrupt any time.",
    modeNotSetUp: "Not set up yet",
    autoListenTitle: "Keep listening after each answer",
    autoListenDesc: "No need to tap “Speak” every time.",
    langNote: "Choose the language (German / English) at the top right.",
    prefsVoiceTitle: "Voice & dossier",
    voiceOnTitle: "Read answers aloud",
    voiceOnDesc: "Off = you only read the answers in the chat.",
    cuesTitle: "Sound cues in the call",
    cuesDesc: "A short tone when it is your turn, when your answer arrived, and when the call ends.",
    speedLabel: "Speaking speed",
    speedSlow: "Slow",
    speedSlower: "A bit slower",
    speedNormal: "Normal",
    speedFaster: "A bit faster",
    speedFast: "Fast",
    autoResolveLabel: "Apply dossier changes automatically",
    autoResolveHelp: "How sure the AI must be before it changes a dossier entry without asking",
    autoResolve50: "Almost always",
    autoResolve70: "When fairly sure",
    autoResolve75: "When sure (recommended)",
    autoResolve85: "Only when very sure",
    autoResolve95: "Only when nearly certain",
    autoResolveOff: "Never – I check everything myself",
    autoResolveNote: "When the AI is unsure, it asks you before changing anything in the dossier.",
    techTitle: "Tech & fine-tuning",
    techSub: "For your tech team – you don't need to touch this",
    voiceModeLabel: "Voice mode",
    voiceModeHelp: "Classic: tap the mic button, speak, send. Live call: hands-free like a phone call - you can talk over the agent any time. Live needs a small voice service (LiveKit worker, see README).",
    sttLabel: "Speech recognition (STT)",
    sttHelp: "Default: your browser recognises your speech itself (Web Speech) - free, nothing to download. Here you can switch to a local model (Whisper): more private, it runs entirely on your computer, but downloads about 250 MB once. In a live call your browser then listens; the voice service only speaks.",
    sttOptBrowser: "Browser (Web Speech) - default",
    sttOptWhisper: "Whisper - local model in the browser",
    llmLabel: "Reply AI (LLM)",
    llmHelp: "The AI that answers you and fills the dossier. \"Server\" runs on the server, \"Browser\" runs on your computer via WebGPU (downloads a model once, then private). Reply and dossier update use the same model. While no model is loaded you can still talk - speech recognition runs independently.",
    llmOptBrowser1: "LFM3 · 1.7B (in the browser, WebGPU)",
    llmOptBrowser2: "Gemma 3n · E2B Nano (in the browser, WebGPU)",
    llmOptBrowser3: "Granite 4 · 3B (in the browser, WebGPU)",
    ttsLabel: "Speech output (TTS)",
    ttsOptLocal: "Browser voice (downloads once, default)",
    ttsOptBrowser: "System voice (Web Speech)",
  },
};

/** @param {string} code BCP-47 or "de"/"en" */
export function chromeLang(code) {
  return String(code || "de").toLowerCase().startsWith("en") ? "en" : "de";
}

/** @param {string} key @param {string} [lang] */
export function t(key, lang = "de") {
  const pack = STR[chromeLang(lang)] || STR.de;
  return pack[key] || STR.en[key] || key;
}

/** Apply `[data-i18n]` / `[data-i18n-placeholder]` / `[data-i18n-title]` / `[data-i18n-aria]` on the page. */
export function applyChromeI18n(lang) {
  const code = chromeLang(lang);
  document.documentElement.lang = code;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    const text = t(key, code);
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.placeholder = text;
    else el.textContent = text;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key) el.setAttribute("placeholder", t(key, code));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title");
    if (key) el.setAttribute("title", t(key, code));
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const key = el.getAttribute("data-i18n-aria");
    if (key) el.setAttribute("aria-label", t(key, code));
  });
  // Mic label may be recreated; keep Speak/Sprechen in sync only when completely idle.
  const micBtn = document.getElementById("micBtn");
  const micLabel = micBtn?.querySelector(".mic-btn__label");
  if (
    micLabel
    && !document.getElementById("app")?.classList.contains("is-listening")
    && !micBtn.classList.contains("is-thinking")
    && !micBtn.classList.contains("is-speaking")
    && !micBtn.classList.contains("is-extracting")
  ) {
    const pressed = micBtn.getAttribute("aria-pressed") === "true";
    // voice.js owns the wording while a mode (e.g. the live call) overrides it.
    if (!pressed && !micBtn.dataset.modeLabel) micLabel.textContent = t("speak", code);
  }
}
