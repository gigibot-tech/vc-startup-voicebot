/**
 * "The founder stopped talking" for the browser's Web Speech recognizer.
 *
 * Web Speech has no usable end-of-speech event: with `continuous` it listens until stopped, and Chrome
 * decides on its own (and late) when a phrase is final. A voice bot needs the opposite - the turn ends
 * a fixed, short time after the LAST word. Every result (interim or final) calls touch(); when no
 * further result arrives for `quietMs`, onQuiet() fires once. Pure + injectable timers, so it is
 * unit-tested without a browser.
 */

export const WEB_SPEECH_QUIET_MS = 1200;

export function createSilenceEnd({
  quietMs = WEB_SPEECH_QUIET_MS, onQuiet, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let timer = null;
  const cancel = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  return {
    /** Words were just heard: restart the countdown. */
    touch() {
      cancel();
      timer = setTimer(() => { timer = null; onQuiet(); }, quietMs);
    },
    cancel,
    isArmed: () => timer !== null,
  };
}
