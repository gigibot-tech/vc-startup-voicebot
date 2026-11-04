/**
 * Word-level diff for the "git diff" proposal cards.
 *
 *   diffWords("CEO und CTO", "CEO, CTO und CPO")
 *     -> { old: [{t:"CEO", k:"same"}, ...{t:"und", k:"del"}...], new: [... {k:"ins"} ...] }
 *
 * Each side is a list of {t: text, k: "same" | "del" | "ins"} so the caller can render the OLD
 * line with red deletions (-) and the NEW line with green insertions (+). Pure function, no DOM.
 */

/** Words, single punctuation marks and whitespace runs are separate tokens ("CEO," -> "CEO" + ","). */
const tokenize = (s) => String(s || "").match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];

/** Longest-common-subsequence over tokens (inputs are short field values, O(n*m) is fine). */
export function diffWords(oldText, newText) {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = { old: [], new: [] };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.old.push({ t: a[i], k: "same" });
      out.new.push({ t: b[j], k: "same" });
      i += 1; j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.old.push({ t: a[i], k: "del" }); i += 1;
    } else {
      out.new.push({ t: b[j], k: "ins" }); j += 1;
    }
  }
  for (; i < a.length; i += 1) out.old.push({ t: a[i], k: "del" });
  for (; j < b.length; j += 1) out.new.push({ t: b[j], k: "ins" });
  return out;
}

/** Render one side as HTML (escaped). Neighbouring tokens of the same kind share one tag. */
export function diffHtml(parts, escape) {
  const runs = [];
  parts.forEach(({ t, k }) => {
    const last = runs[runs.length - 1];
    if (last && last.k === k) last.t += t; else runs.push({ t, k });
  });
  return runs.map(({ t, k }) => {
    const text = escape(t);
    if (k === "same" || !t.trim()) return text;
    const tag = k === "del" ? "del" : "ins";
    return `<${tag} class="diff-${k}">${text}</${tag}>`;
  }).join("");
}
