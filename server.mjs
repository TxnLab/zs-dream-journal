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
} from "./lib/dreams.mjs";

const PORT = Number(process.env.PORT || 5177);
const PROXY_URL = (process.env.ZS_PROXY_URL || "http://127.0.0.1:9376").replace(/\/+$/, "");
const JOURNAL_FILE = process.env.DREAM_JOURNAL_FILE || path.join(os.homedir(), ".zs-dream-journal", "journal.enc");
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
// Anything else is a DNS-rebinding attempt or a misconfigured client.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

const DEFAULT_SETTINGS = {
  model: "anthropic/claude-haiku-5.5",
  relayRequired: true,
  requireTee: false,
  privateTerms: "",
  autoLockMinutes: 15,
};

const zs = createClient({ baseUrl: PROXY_URL });

// The unlocked journal: { token, vault, data, lastActive, busy }. One at a time.
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
function persist(s) {
  saving = saving.catch(() => {}).then(() => vault.save(s.vault, s.data));
  return saving;
}

function newJournal() {
  return { version: 1, createdAt: new Date().toISOString(), settings: { ...DEFAULT_SETTINGS }, dreams: [], ledger: [], patterns: null };
}

function startSession(v, data) {
  if (session) lock();
  session = { token: randomBytes(32).toString("hex"), vault: v, data, lastActive: Date.now(), busy: 0 };
  return session;
}

function lock() {
  if (!session) return;
  vault.close(session.vault);
  session = null;
}

setInterval(() => {
  if (session && !session.busy && Date.now() - session.lastActive > session.data.settings.autoLockMinutes * 60_000) lock();
}, 30_000).unref();

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

// Sends one request through the proxy and records its receipt in the ledger.
async function callModel(s, kind, messages, maxTokens) {
  const st = s.data.settings;
  const info = await liveModels().then((l) => l.find((m) => m.id === st.model), () => undefined);
  const result = await zs.chat({
    model: st.model,
    messages,
    maxTokens,
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
  return { content: result.content, receipt, sent };
}

async function analyze(s, dream) {
  const { text, map } = pseudonymize(dream.text, parseTerms(s.data.settings.privateTerms));
  const messages = [
    { role: "system", content: ANALYSIS_PROMPT },
    { role: "user", content: text },
  ];
  s.busy++;
  try {
    const { content, receipt, sent } = await callModel(s, "analysis", messages, 1500);
    dream.receipt = receipt;
    dream.sent = sent;
    try {
      dream.analysis = restore(normalizeAnalysis(extractJson(content)), map);
      dream.error = null;
      dream.rawReply = null;
    } catch {
      dream.error = "The reply wasn't in the expected format. Analyze again, or pick another model in Settings.";
      dream.rawReply = restore(content, map).slice(0, 8000);
    }
  } catch (err) {
    dream.error = err.message;
  } finally {
    s.busy--;
    dream.updatedAt = new Date().toISOString();
    await persist(s);
  }
}

async function findPatterns(s, count) {
  const items = patternSummaries(s.data.dreams, count);
  if (items.length < 2) throw new HttpError(400, "Analyze at least two dreams first.");
  const { text, map } = pseudonymize(JSON.stringify(items, null, 1), parseTerms(s.data.settings.privateTerms));
  const messages = [
    { role: "system", content: PATTERNS_PROMPT },
    { role: "user", content: text },
  ];
  s.busy++;
  try {
    const { content, receipt, sent } = await callModel(s, "patterns", messages, 1500);
    let result;
    try {
      result = restore(normalizePatterns(extractJson(content)), map);
    } catch {
      await persist(s);
      throw new HttpError(502, "The reply wasn't in the expected format. Try again, or pick another model in Settings.");
    }
    s.data.patterns = { at: new Date().toISOString(), count: items.length, result, receipt, sent };
    await persist(s);
  } finally {
    s.busy--;
  }
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

function view(data) {
  return { settings: data.settings, dreams: [...data.dreams].sort(byDate).reverse(), ledger: data.ledger, patterns: data.patterns };
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
      try {
        const opened = await vault.open(JOURNAL_FILE, passphrase);
        s = startSession(opened.vault, opened.data);
      } catch (err) {
        if (err instanceof vault.WrongPassphrase) throw new HttpError(401, err.message);
        throw err;
      }
    }
    return send(res, 200, { token: s.token, journal: view(s.data) });
  }

  const s = requireSession(req);

  if (m === "POST" && p === "/api/lock") {
    lock();
    return send(res, 200, { locked: true });
  }
  if (m === "GET" && p === "/api/journal") return send(res, 200, { journal: view(s.data) });
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
    return send(res, 200, { journal: view(s.data) });
  }

  if (m === "POST" && p === "/api/dreams") {
    const b = await readJson(req);
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text) throw new HttpError(400, "Write down the dream first.");
    if (text.length > 20_000) throw new HttpError(400, "That entry is too long (20,000 characters at most).");
    const now = new Date().toISOString();
    const dream = {
      id: randomUUID(),
      date: isDate(b.date) ? b.date : now.slice(0, 10),
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
    await analyze(s, dream);
    return send(res, 200, { journal: view(s.data), id: dream.id });
  }

  if (m === "POST" && p === "/api/patterns") {
    const b = await readJson(req);
    const count = Number.isFinite(b.count) ? Math.min(1000, Math.max(2, Math.round(b.count))) : 30;
    await findPatterns(s, count);
    return send(res, 200, { journal: view(s.data) });
  }

  const match = p.match(/^\/api\/dreams\/([0-9a-f-]{36})(\/analyze)?$/);
  if (match) {
    const dream = findDream(s, match[1]);
    if (m === "POST" && match[2]) {
      await analyze(s, dream);
      return send(res, 200, { journal: view(s.data), id: dream.id });
    }
    if (m === "DELETE" && !match[2]) {
      s.data.dreams = s.data.dreams.filter((d) => d !== dream);
      await persist(s);
      return send(res, 200, { journal: view(s.data) });
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
    if (!res.headersSent) send(res, status, { error: err.message });
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
