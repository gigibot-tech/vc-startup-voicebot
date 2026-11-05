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
    heroSub: "im HTGF-Erstgespräch",
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
    updatingDossier: "Dossier wird aktualisiert…",
    thinking: "Thinking…",
    processingReply: "Thinking…",
    loadingSession: "Gespräch wird geladen…",
    finalizingDossier: "Dossier wird abgeschlossen…",
    sessionPick: "Gespräch wählen…",
    noSessions: "Noch keine Gespräche",
    langLabel: "Sprache für STT/TTS und Interview (aktiv + neu)",
    interviewLang: "Interview-Sprache",
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
    heroSub: "in the HTGF first call",
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
    updatingDossier: "Updating dossier…",
    thinking: "Thinking…",
    processingReply: "Thinking…",
    loadingSession: "Loading session…",
    finalizingDossier: "Finalizing dossier…",
    sessionPick: "Choose session…",
    noSessions: "No sessions yet",
    langLabel: "Language for STT/TTS and interview (active + new sessions)",
    interviewLang: "Interview language",
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
  // Mic label may be recreated; keep Speak/Sprechen in sync when idle.
  const micLabel = document.querySelector("#micBtn .mic-btn__label");
  if (micLabel && !document.getElementById("app")?.classList.contains("is-listening")) {
    const pressed = document.getElementById("micBtn")?.getAttribute("aria-pressed") === "true";
    if (!pressed) micLabel.textContent = t("speak", code);
  }
}
