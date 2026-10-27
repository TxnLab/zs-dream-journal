// What goes to the model and what comes back: the two prompts, private-term
// placeholders, and normalization of the model's JSON into a fixed shape.

export const DREAM_TYPES = ["ordinary", "vivid", "nightmare", "lucid", "recurring", "fragment"];

export const ANALYSIS_PROMPT = `You are a careful, non-judgmental dream analyst and archivist.
You will receive one entry from a private dream journal, exactly as the dreamer wrote it.
Some names and places have been replaced with placeholders such as "Person A" or "place B". Keep every placeholder exactly as written and never guess what it stands for.

Treat dreams as strange, personal material. Do not diagnose, moralize, or tell the dreamer what a dream "really" means. Offer readings as possibilities from different lenses (personal association, recent memory, Jungian symbolism, emotional processing), and say which lens each reading comes from.

Reply with only a JSON object, with nothing before or after it, in this shape:
{
  "title": "an evocative title of 3 to 6 words",
  "summary": "one or two plain sentences describing what happened",
  "dream_type": "one of: ordinary, vivid, nightmare, lucid, recurring, fragment",
  "vividness": 3,
  "emotions": ["up to 5 single words, lowercase"],
  "themes": ["up to 5 short lowercase phrases, like 'being chased' or 'lost in a building'"],
  "symbols": [{"symbol": "a concrete image from the dream, lowercase", "note": "one sentence on what it might connect to"}],
  "people": ["people or figures as written, placeholders kept, or roles like 'a stranger'"],
  "places": ["settings, lowercase"],
  "interpretation": "three to five sentences offering two or three possible readings",
  "question": "one gentle question the dreamer could sit with"
}
vividness is an integer from 1 (faint) to 5 (as real as waking life). Use at most 6 symbols.`;

export const PATTERNS_PROMPT = `You are a careful, non-judgmental dream analyst.
You will receive structured summaries of several dreams from one private journal, oldest first. You will not see the dreams themselves. Some names are placeholders such as "Person A"; keep them exactly as written.

Look for what recurs and what changes over time. Do not diagnose or moralize. Reply with only a JSON object, with nothing before or after it, in this shape:
{
  "recurring_symbols": [{"symbol": "lowercase", "count": 2, "observation": "one sentence"}],
  "recurring_themes": [{"theme": "lowercase", "count": 2, "observation": "one sentence"}],
  "emotional_trend": "two or three sentences on how the emotional tone moves across the dreams",
  "shifts": "one or two sentences on anything that appeared, disappeared, or changed",
  "reflection": "three or four sentences tying the patterns together, offered as possibilities",
  "experiment": "one small, concrete thing the dreamer could try or notice in the coming week"
}
Use at most 6 recurring symbols and 6 recurring themes.`;

// One term per line. "Sarah" becomes "Person A"; "Acme Corp = workplace"
// becomes "workplace B".
export function parseTerms(text = "") {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const eq = line.indexOf("=");
      const term = (eq < 0 ? line : line.slice(0, eq)).trim();
      const label = eq < 0 ? "" : line.slice(eq + 1).trim();
      return term ? { term, label: label || "Person" } : null;
    })
    .filter(Boolean);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole words only, so "Al" never matches inside "Alice". Case-insensitive,
// which also catches a placeholder the model lowercased.
const wordRe = (s) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}(?![\\p{L}\\p{N}])`, "giu");

function letters(n) {
  let s = "";
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function pseudonymize(text, terms) {
  const map = [];
  const perLabel = new Map();
  let out = text;
  // Longest first, so "Mary Ann" is replaced before "Mary".
  for (const { term, label } of [...terms].sort((a, b) => b.term.length - a.term.length)) {
    if (!wordRe(term).test(out)) continue;
    const n = perLabel.get(label) ?? 0;
    perLabel.set(label, n + 1);
    const placeholder = `${label} ${letters(n)}`;
    out = out.replace(wordRe(term), placeholder);
    map.push([placeholder, term]);
  }
  return { text: out, map };
}

export function restore(value, map) {
  if (!map.length) return value;
  if (typeof value === "string") {
    // Longest placeholder first, so "Person AA" is restored before "Person A".
    return [...map]
      .sort((a, b) => b[0].length - a[0].length)
      .reduce((s, [placeholder, term]) => s.replace(wordRe(placeholder), term), value);
  }
  if (Array.isArray(value)) return value.map((v) => restore(v, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restore(v, map)]));
  }
  return value;
}

export function extractJson(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the reply");
  return JSON.parse(cleaned.slice(start, end + 1));
}

const str = (v, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const lower = (v, max) => (Array.isArray(v) ? v : []).map((x) => str(x, 120).toLowerCase()).filter(Boolean).slice(0, max);
const plain = (v, max) => (Array.isArray(v) ? v : []).map((x) => str(x, 120)).filter(Boolean).slice(0, max);

export function normalizeAnalysis(a) {
  const type = str(a?.dream_type).toLowerCase();
  const vividness = Math.round(Number(a?.vividness));
  return {
    title: str(a?.title, 120) || "Untitled dream",
    summary: str(a?.summary, 1000),
    dream_type: DREAM_TYPES.includes(type) ? type : "ordinary",
    vividness: vividness >= 1 && vividness <= 5 ? vividness : 3,
    emotions: lower(a?.emotions, 5),
    themes: lower(a?.themes, 5),
    symbols: (Array.isArray(a?.symbols) ? a.symbols : [])
      .map((s) => ({ symbol: str(typeof s === "string" ? s : s?.symbol, 80).toLowerCase(), note: str(s?.note, 400) }))
      .filter((s) => s.symbol)
      .slice(0, 6),
    people: plain(a?.people, 8),
    places: lower(a?.places, 6),
    interpretation: str(a?.interpretation),
    question: str(a?.question, 400),
  };
}

export function normalizePatterns(p) {
  const counted = (v, key) =>
    (Array.isArray(v) ? v : [])
      .map((x) => ({
        [key]: str(x?.[key], 80).toLowerCase(),
        count: Math.max(1, Math.round(Number(x?.count)) || 1),
        observation: str(x?.observation, 400),
      }))
      .filter((x) => x[key])
      .slice(0, 6);
  return {
    recurring_symbols: counted(p?.recurring_symbols, "symbol"),
    recurring_themes: counted(p?.recurring_themes, "theme"),
    emotional_trend: str(p?.emotional_trend),
    shifts: str(p?.shifts),
    reflection: str(p?.reflection),
    experiment: str(p?.experiment, 600),
  };
}

export const byDate = (a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt);

// What the patterns request sends: the structured analysis of each dream,
// oldest first, numbered instead of dated. Never the dream text or summary.
export function patternSummaries(dreams, count) {
  return dreams
    .filter((d) => d.analysis)
    .sort(byDate)
    .slice(-count)
    .map((d, i) => ({
      n: i + 1,
      title: d.analysis.title,
      dream_type: d.analysis.dream_type,
      vividness: d.analysis.vividness,
      emotions: d.analysis.emotions,
      themes: d.analysis.themes,
      symbols: d.analysis.symbols.map((s) => s.symbol),
      places: d.analysis.places,
    }));
}
