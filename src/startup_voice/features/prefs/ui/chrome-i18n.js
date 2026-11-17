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
    deleteSession: "Gespräch löschen",
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
    updatingDossier: "Dossier wird aktualisiert…",
    thinking: "Thinking…",
    processingReply: "Thinking…",
    loadingSession: "Gespräch wird geladen…",
    finalizingDossier: "Dossier wird abgeschlossen…",
    sessionPick: "Gespräch wählen…",
    noSessions: "Noch keine Gespräche",
    langLabel: "Sprache für STT/TTS und Interview (aktiv + neu)",
    interviewLang: "Interview-Sprache",
    // Settings panel (founder-friendly)
    prefsTalkTitle: "Wie möchtest du sprechen?",
    modeClassicTitle: "Antippen & sprechen",
    modeClassicDesc: "Tippe auf „Sprechen“, erzähl, tippe auf „Stopp“. Wie eine Sprachnachricht.",
    modeLiveTitle: "Freies Gespräch",
    modeLiveDesc: "Wie ein Telefonat: einfach reden, jederzeit unterbrechen.",
    modeNotSetUp: "Noch nicht eingerichtet",
    autoListenTitle: "Nach der Antwort gleich weiter zuhören",
    autoListenDesc: "Du musst nicht jedes Mal neu auf „Sprechen“ tippen.",
    langNote: "Die Sprache (Deutsch / Englisch) stellst du oben rechts ein.",
    prefsVoiceTitle: "Stimme & Dossier",
    voiceOnTitle: "Antworten laut vorlesen",
    voiceOnDesc: "Aus = du liest die Antworten nur im Chat.",
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
    deleteSession: "Delete session",
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
    updatingDossier: "Updating dossier…",
    thinking: "Thinking…",
    processingReply: "Thinking…",
    loadingSession: "Loading session…",
    finalizingDossier: "Finalizing dossier…",
    sessionPick: "Choose session…",
    noSessions: "No sessions yet",
    langLabel: "Language for STT/TTS and interview (active + new sessions)",
    interviewLang: "Interview language",
    // Settings panel (founder-friendly)
    prefsTalkTitle: "How do you want to talk?",
    modeClassicTitle: "Tap & talk",
    modeClassicDesc: "Tap “Speak”, tell your story, tap “Stop”. Like a voice message.",
    modeLiveTitle: "Free conversation",
    modeLiveDesc: "Like a phone call: just talk, interrupt any time.",
    modeNotSetUp: "Not set up yet",
    autoListenTitle: "Keep listening after each answer",
    autoListenDesc: "No need to tap “Speak” every time.",
    langNote: "Choose the language (German / English) at the top right.",
    prefsVoiceTitle: "Voice & dossier",
    voiceOnTitle: "Read answers aloud",
    voiceOnDesc: "Off = you only read the answers in the chat.",
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
    if (!pressed) micLabel.textContent = t("speak", code);
  }
}
