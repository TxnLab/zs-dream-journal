// Local server for the dream journal. It listens on 127.0.0.1 only, holds the
// decrypted journal in memory while unlocked, and sends analysis through the
// local zs-proxy, which seals each request before it leaves the machine.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as vault from "./lib/vault.mjs";
import { createClient, ProxyError } from "./lib/zs.mjs";
import {
  ANALYSIS_PROMPT,
  PATTERNS_PROMPT,
  byDate,
  extractJson,
  normalizeAnalysis,
  normalizePatterns,
  parseTerms,
  patternSummaries,
  pseudonymize,
  restore,
  systemPrompt,
} from "./lib/dreams.mjs";

const PORT = Number(process.env.PORT || 5177);
const PROXY_URL = (process.env.ZS_PROXY_URL || "http://127.0.0.1:9376").replace(/\/+$/, "");
const JOURNAL_FILE = process.env.DREAM_JOURNAL_FILE || path.join(os.homedir(), ".zs-dream-journal", "journal.enc");
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
// Anything else is a DNS-rebinding attempt or a misconfigured client.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
// A ceiling on each reply, not a target: receipts bill the tokens actually
// used. Reasoning models spend part of it thinking before they answer.
const MAX_TOKENS = 8192;

const DEFAULT_SETTINGS = {
  model: "anthropic/claude-haiku-5.5",
  relayRequired: true,
  requireTee: false,
  privateTerms: "",
  autoLockMinutes: 15,
};

const zs = createClient({ baseUrl: PROXY_URL });

// The unlocked journal: { token, vault, data, lastActive, work, rev }. One at a time.
let session = null;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- persistence

let saving = Promise.resolve();
// Serializes writes: two overlapping saves would race on the temp file.
function serialize(write) {
  saving = saving.catch(() => {}).then(write);
  return saving;
}

function persist(s) {
  // Counts changes, so the page can tell which of two replies is newer.
  s.rev++;
  return serialize(() => vault.save(s.vault, s.data));
}

function newJournal() {
  return { version: 1, createdAt: new Date().toISOString(), settings: { ...DEFAULT_SETTINGS }, dreams: [], ledger: [], patterns: null };
}

const newToken = () => randomBytes(32).toString("hex");

function startSession(v, data) {
  if (session) lock();
  session = { token: newToken(), vault: v, data, lastActive: Date.now(), work: new Map(), rev: 0 };
  return session;
}

// Locking ends the session at once, so its token stops working. Model calls
// already under way have been paid for, so they still finish and save; then
// the key is wiped.
let closing = Promise.resolve();
function lock() {
  if (!session) return;
  const s = session;
  session = null;
  closing = Promise.allSettled(s.work.values())
    .then(() => saving)
    .catch(() => {})
    .then(() => vault.close(s.vault));
}

// The page locks itself when idle and pings while someone's reading. This is
// the backstop for a page that was closed, with a minute's grace for the ping.
setInterval(() => {
  if (session && Date.now() - session.lastActive > (session.data.settings.autoLockMinutes + 1) * 60_000) lock();
}, 30_000).unref();

async function unlock(passphrase) {
  // Still unlocked, from another tab or before a reload: rejoin that session.
  // Reading the file again would miss analyses it hasn't saved yet.
  const current = session;
  if (current && (await vault.verify(current.vault, passphrase)) && session === current) {
    current.token = newToken();
    current.lastActive = Date.now();
    return current;
  }
  // A session that just locked may still be finishing its work.
  await closing;
  try {
    const opened = await vault.open(JOURNAL_FILE, passphrase);
    return startSession(opened.vault, opened.data);
  } catch (err) {
    if (err instanceof vault.WrongPassphrase) throw new HttpError(401, err.message);
    throw err;
  }
}

// ------------------------------------------------------------------ the model

let modelCache = { at: 0, list: [] };
async function liveModels() {
  if (modelCache.list.length && Date.now() - modelCache.at < 5 * 60_000) return modelCache.list;
  const list = (await zs.models())
    .filter((m) => m.pricing)
    .map((m) => ({
      id: m.id,
      input: Number(m.pricing.prompt) * 1e6,
      output: Number(m.pricing.completion) * 1e6,
      context: m.context_length,
      efforts: m.reasoning?.allowed_efforts ?? [],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  modelCache = { at: Date.now(), list };
  return list;
}

// Proxy failures in plain words, with what to do next. The proxy refuses an
// unmet routing preference before anything leaves the machine.
const PLAIN = {
  unreachable: `The ZeroSignal proxy isn't answering at ${PROXY_URL}. Start it with "zs-proxy proxy start", then try again.`,
  timeout: "The model took too long to answer. Try again, or pick a faster model in Settings.",
  wallet_unfunded: "Your ZeroSignal wallet needs funds to pay for analysis. Add some at zerosignal.ai, then try again.",
  no_relay_available:
    'No relay was available, so nothing was sent. Try again in a minute, or turn off "Require a relay" in Settings if you\'re comfortable sending without one.',
  no_tee_capacity:
    'No operator with attested hardware is serving this model right now, so nothing was sent. Pick another model, or turn off "Require attested hardware" in Settings.',
};

function explain(err) {
  if (!(err instanceof ProxyError)) return err.message;
  const plain = PLAIN[err.code] ?? (err.status === 402 ? PLAIN.wallet_unfunded : null);
  return plain ?? `The model didn't answer. Try again, or pick another model in Settings. (${err.message})`;
}

// A reply that hit MAX_TOKENS stops mid-object. That looks like bad JSON, but
// it isn't the model ignoring the format.
const unreadable = (finish) =>
  finish === "length"
    ? "The model ran out of room before it finished its reply. Try again, or pick another model in Settings."
    : "The reply wasn't in the expected format. Try again, or pick another model in Settings.";

// Sends one request through the proxy and records its receipt in the ledger.
async function callModel(s, kind, messages) {
  const st = s.data.settings;
  const info = await liveModels().then((l) => l.find((m) => m.id === st.model), () => undefined);
  const result = await zs.chat({
    model: st.model,
    messages,
    maxTokens: MAX_TOKENS,
    relay: st.relayRequired ? "required" : undefined,
    requireTee: st.requireTee,
    // Keep reasoning short where the model lets us choose; the output is a
    // small JSON object, not a proof.
    reasoningEffort: info?.efforts.includes("low") ? "low" : undefined,
  });
  const u = result.usage;
  const receipt = {
    at: new Date().toISOString(),
    kind,
    model: st.model,
    relay: st.relayRequired ? "required" : "default",
    tee: st.requireTee,
    operator: u?.operator_id ?? null,
    node: u?.node_id ?? null,
    ticket: u?.ticket_id ?? null,
    inputTokens: u?.actual_input_count ?? null,
    outputTokens: u?.actual_output_count ?? null,
    usd: u?.fee?.total_debit_usd ?? u?.inference?.amount_usd ?? null,
  };
  s.data.ledger.push(receipt);
  // What left the machine, sealed: the request body without `provider`, which
  // the proxy reads and strips before sending.
  const { provider, stream, ...sent } = result.body;
  return { content: result.content, finish: result.finish, receipt, sent };
}

// Runs model work that has to finish and save even if the journal locks
// meanwhile: lock() waits for it. One job per key at a time.
function run(s, key, job) {
  if (!s.work.has(key)) {
    s.rev++;
    const p = job().finally(() => {
      s.work.delete(key);
      s.rev++;
    });
    s.work.set(key, p);
  }
  return s.work.get(key);
}

// Analysis runs after the reply, so saving a dream returns at once. The page
// polls the journal until it's done.
function analyzeLater(s, dream) {
  run(s, dream.id, () => analyze(s, dream)).catch((err) => console.error(err));
}

async function analyze(s, dream) {
  const original = dream.text;
  const { text, map } = pseudonymize(original, parseTerms(s.data.settings.privateTerms));
  const messages = [
    { role: "system", content: systemPrompt(ANALYSIS_PROMPT, map) },
    { role: "user", content: text },
  ];
  try {
    const { content, finish, receipt, sent } = await callModel(s, "analysis", messages);
    dream.receipt = receipt;
    dream.sent = sent;
    try {
      dream.analysis = restore(normalizeAnalysis(extractJson(content)), map);
      // Edited while this ran: the analysis describes the old words.
      dream.stale = dream.text !== original;
      dream.error = null;
      dream.rawReply = null;
    } catch {
      dream.error = unreadable(finish);
      dream.rawReply = restore(content, map).slice(0, 8000);
    }
  } catch (err) {
    dream.error = explain(err);
    dream.rawReply = null;
  } finally {
    dream.updatedAt = new Date().toISOString();
    await persist(s);
  }
}

async function findPatterns(s, count) {
  const items = patternSummaries(s.data.dreams, count);
  if (items.length < 2) throw new HttpError(400, "Analyze at least two dreams first.");
  const { text, map } = pseudonymize(JSON.stringify(items, null, 1), parseTerms(s.data.settings.privateTerms));
  const messages = [
    { role: "system", content: systemPrompt(PATTERNS_PROMPT, map) },
    { role: "user", content: text },
  ];
  const { content, finish, receipt, sent } = await callModel(s, "patterns", messages);
  let result;
  try {
    result = restore(normalizePatterns(extractJson(content)), map);
  } catch {
    await persist(s);
    throw new HttpError(502, unreadable(finish));
  }
  s.data.patterns = { at: new Date().toISOString(), count: items.length, result, receipt, sent };
  await persist(s);
}

// ----------------------------------------------------------------------- HTTP

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, "Request too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Malformed JSON.");
  }
}

function view(s) {
  const { settings, dreams, ledger, patterns } = s.data;
  return {
    settings,
    dreams: [...dreams].sort(byDate).reverse(),
    ledger,
    patterns,
    analyzing: [...s.work.keys()].filter((k) => k !== "patterns"),
    rev: s.rev,
  };
}

function requireSession(req) {
  const token = req.headers["x-session"];
  const ok =
    session &&
    typeof token === "string" &&
    token.length === session.token.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(session.token));
  if (!ok) throw new HttpError(401, "Locked.");
  session.lastActive = Date.now();
  return session;
}

function findDream(s, id) {
  const dream = s.data.dreams.find((d) => d.id === id);
  if (!dream) throw new HttpError(404, "No such dream.");
  return dream;
}

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// The date and text of an entry, from the composer or the editor.
function entry(b) {
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) throw new HttpError(400, "Write down the dream first.");
  if (text.length > 20_000) throw new HttpError(400, "That entry is too long (20,000 characters at most).");
  return { date: isDate(b.date) ? b.date : null, text };
}

async function route(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (m === "GET" && p === "/api/status") {
    return send(res, 200, { exists: await vault.exists(JOURNAL_FILE), file: JOURNAL_FILE, proxy: PROXY_URL, proxyOnline: await zs.healthy() });
  }
  if (m === "POST" && (p === "/api/create" || p === "/api/unlock")) {
    const { passphrase } = await readJson(req);
    if (typeof passphrase !== "string" || !passphrase) throw new HttpError(400, "Enter a passphrase.");
    let s;
    if (p === "/api/create") {
      if (await vault.exists(JOURNAL_FILE)) throw new HttpError(409, "A journal already exists. Unlock it instead.");
      if (passphrase.length < 8) throw new HttpError(400, "Use a passphrase of at least 8 characters.");
      const data = newJournal();
      s = startSession(await vault.create(JOURNAL_FILE, passphrase, data), data);
    } else {
      s = await unlock(passphrase);
    }
    return send(res, 200, { token: s.token, journal: view(s) });
  }

  const s = requireSession(req);

  if (m === "POST" && p === "/api/lock") {
    lock();
    return send(res, 200, { locked: true });
  }
  // The page sends this while someone's reading, so the server knows they're
  // still there even though reading needs no other request.
  if (m === "POST" && p === "/api/ping") return send(res, 200, {});
  if (m === "GET" && p === "/api/journal") return send(res, 200, { journal: view(s) });
  if (m === "GET" && p === "/api/models") return send(res, 200, { models: await liveModels() });

  if (m === "PUT" && p === "/api/settings") {
    const b = await readJson(req);
    const st = s.data.settings;
    if (typeof b.model === "string" && b.model.trim()) st.model = b.model.trim();
    if (typeof b.relayRequired === "boolean") st.relayRequired = b.relayRequired;
    if (typeof b.requireTee === "boolean") st.requireTee = b.requireTee;
    if (typeof b.privateTerms === "string") st.privateTerms = b.privateTerms.slice(0, 10_000);
    if (Number.isFinite(b.autoLockMinutes)) st.autoLockMinutes = Math.min(240, Math.max(1, Math.round(b.autoLockMinutes)));
    await persist(s);
    return send(res, 200, { journal: view(s) });
  }

  if (m === "POST" && p === "/api/passphrase") {
    const { current, next } = await readJson(req);
    if (typeof current !== "string" || !(await vault.verify(s.vault, current))) throw new HttpError(403, "That isn't your current passphrase.");
    if (typeof next !== "string" || next.length < 8) throw new HttpError(400, "Use a new passphrase of at least 8 characters.");
    await serialize(() => vault.rekey(s.vault, next, s.data));
    return send(res, 200, { changed: true });
  }

  if (m === "POST" && p === "/api/dreams") {
    const { date, text } = entry(await readJson(req));
    const now = new Date().toISOString();
    const dream = {
      id: randomUUID(),
      date: date ?? now.slice(0, 10),
      text,
      createdAt: now,
      updatedAt: now,
      analysis: null,
      receipt: null,
      sent: null,
      error: null,
    };
    s.data.dreams.push(dream);
    // Saved before anything is sent, so a failed analysis never loses the entry.
    await persist(s);
    analyzeLater(s, dream);
    return send(res, 200, { journal: view(s), id: dream.id });
  }

  if (m === "POST" && p === "/api/patterns") {
    const b = await readJson(req);
    const count = Number.isFinite(b.count) ? Math.min(1000, Math.max(2, Math.round(b.count))) : 30;
    await run(s, "patterns", () => findPatterns(s, count));
    return send(res, 200, { journal: view(s) });
  }

  const match = p.match(/^\/api\/dreams\/([0-9a-f-]{36})(\/analyze)?$/);
  if (match) {
    const dream = findDream(s, match[1]);
    if (m === "POST" && match[2]) {
      analyzeLater(s, dream);
      return send(res, 200, { journal: view(s), id: dream.id });
    }
    if (m === "PUT" && !match[2]) {
      const { date, text } = entry(await readJson(req));
      if (text !== dream.text) {
        dream.text = text;
        // The analysis describes the old words until it's run again.
        dream.stale = Boolean(dream.analysis);
      }
      if (date) dream.date = date;
      dream.updatedAt = new Date().toISOString();
      await persist(s);
      return send(res, 200, { journal: view(s) });
    }
    if (m === "DELETE" && !match[2]) {
      s.data.dreams = s.data.dreams.filter((d) => d !== dream);
      await persist(s);
      return send(res, 200, { journal: view(s) });
    }
  }
  throw new HttpError(404, "Not found.");
}

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/sky.js": ["sky.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

// The page loads nothing from anywhere but this server: no fonts, no
// analytics, no CDN. Network requests only go to /api on this origin.
const PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host)) throw new HttpError(421, "Unexpected Host header.");
    const url = new URL(req.url, `http://${req.headers.host}`);
    const file = STATIC[url.pathname];
    if (req.method === "GET" && file) {
      const body = await readFile(path.join(PUBLIC_DIR, file[0]));
      res.writeHead(200, { "Content-Type": file[1], ...PAGE_HEADERS });
      return res.end(body);
    }
    if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found.");
    // Blocks other websites from driving this API from your browser.
    const origin = req.headers.origin;
    if (req.method !== "GET" && origin && !ALLOWED_ORIGINS.has(origin)) throw new HttpError(403, "Cross-origin request refused.");
    await route(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : err instanceof ProxyError ? 502 : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: explain(err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Dream journal running at http://127.0.0.1:${PORT}`);
  console.log(`  journal file: ${JOURNAL_FILE}`);
  console.log(`  ZeroSignal proxy: ${PROXY_URL}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    lock();
    process.exit(0);
  });
}
