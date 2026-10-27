// Runs the real server against a fake zs-proxy, for what lives in server.mjs:
// background analysis, locking mid-analysis, editing, passphrases and errors.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as vault from "../lib/vault.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const USAGE = { type: "zs.usage", ticket_id: "t", operator_id: 1, node_id: 1, actual_input_count: 10, actual_output_count: 5, fee: { total_debit_usd: 0.001 } };

// What the fake proxy does with the next chat request.
let reply = { content: '{"title":"Paid for"}' };
const proxy = http.createServer((req, res) => {
  if (req.url === "/healthz") return res.end("{}");
  if (req.url === "/v1/models") return res.end('{"data":[]}');
  req.resume();
  const r = reply;
  setTimeout(() => {
    if (r.error) {
      res.writeHead(r.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: r.error }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: r.content }, finish_reason: r.finish ?? "stop" }] })}\n\n`);
    res.end(`event: zs.usage\ndata: ${JSON.stringify(USAGE)}\n\n`);
  }, r.delay ?? 0);
});

let dir, file, port, child;
let token = null;

async function freePort() {
  const probe = http.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  return port;
}

before(async () => {
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  dir = await mkdtemp(path.join(os.tmpdir(), "dream-server-"));
  file = path.join(dir, "journal.enc");
  port = await freePort();
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ZS_PROXY_URL: `http://127.0.0.1:${proxy.address().port}`, DREAM_JOURNAL_FILE: file },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await once(child.stdout, "data");
});

after(async () => {
  child.kill();
  proxy.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function api(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "X-Session": token } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
}

async function unlock(passphrase) {
  const r = await api("POST", "/api/unlock", { passphrase });
  if (r.token) token = r.token;
  return r;
}

// The journal once no analysis is running.
async function settled() {
  for (;;) {
    const { journal } = await api("GET", "/api/journal");
    if (!journal.analyzing.length) return journal;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const dreamIn = (journal, id) => journal.dreams.find((d) => d.id === id);
let id;

test("saving returns at once, and the analysis lands in the background", async () => {
  token = (await api("POST", "/api/create", { passphrase: "correct horse" })).token;
  reply = { content: '{"title":"Paid for"}', delay: 300 };
  const r = await api("POST", "/api/dreams", { date: "2026-10-27", text: "I was at Acme" });
  id = r.id;
  assert.deepEqual(r.journal.analyzing, [id]);
  assert.equal(dreamIn(r.journal, id).analysis, null);
  const journal = await settled();
  assert.equal(dreamIn(journal, id).analysis.title, "Paid for");
  assert.equal(journal.ledger.length, 1);
  // With no private terms, the dream goes out as written, and the prompt doesn't claim otherwise.
  const { messages } = dreamIn(journal, id).sent;
  assert.equal(messages[1].content, "I was at Acme");
  assert.doesNotMatch(messages[0].content, /placeholder/i);
});

test("locking mid-analysis still saves the analysis and its receipt", async () => {
  reply = { content: '{"title":"Still paid for"}', delay: 300 };
  await api("POST", `/api/dreams/${id}/analyze`);
  assert.equal((await api("POST", "/api/lock")).status, 200);
  assert.equal((await api("GET", "/api/journal")).status, 401);
  const { journal } = await unlock("correct horse");
  assert.equal(dreamIn(journal, id).analysis.title, "Still paid for");
  assert.equal(journal.ledger.length, 2);
});

test("a second unlock rejoins the open session, and the first token stops working", async () => {
  const first = token;
  const { journal } = await unlock("correct horse");
  assert.notEqual(token, first);
  assert.equal(journal.ledger.length, 2);
  const res = await fetch(`http://127.0.0.1:${port}/api/journal`, { headers: { "X-Session": first } });
  assert.equal(res.status, 401);
});

test("an edit marks the analysis stale, including one made while it runs", async () => {
  let { journal } = await api("PUT", `/api/dreams/${id}`, { date: "2026-10-26", text: "I was at the office" });
  assert.equal(dreamIn(journal, id).stale, true);
  assert.equal(dreamIn(journal, id).date, "2026-10-26");
  assert.equal(dreamIn(journal, id).analysis.title, "Still paid for");

  reply = { content: '{"title":"Office"}', delay: 300 };
  await api("POST", `/api/dreams/${id}/analyze`);
  await api("PUT", `/api/dreams/${id}`, { text: "I was at the office, then home" });
  journal = await settled();
  assert.equal(dreamIn(journal, id).stale, true);

  reply = { content: '{"title":"Home"}' };
  await api("POST", `/api/dreams/${id}/analyze`);
  journal = await settled();
  assert.equal(dreamIn(journal, id).stale, false);
  assert.equal(dreamIn(journal, id).analysis.title, "Home");
});

test("proxy errors and cut-off replies come back in plain words", async () => {
  reply = { status: 503, error: { code: "no_relay_available", message: "no relay" } };
  await api("POST", `/api/dreams/${id}/analyze`);
  let dream = dreamIn(await settled(), id);
  assert.match(dream.error, /^No relay was available, so nothing was sent\./);

  reply = { content: '{"title":"Cut', finish: "length" };
  await api("POST", `/api/dreams/${id}/analyze`);
  dream = dreamIn(await settled(), id);
  assert.match(dream.error, /ran out of room/);
  assert.equal(dream.analysis.title, "Home");
});

test("changing the passphrase needs the current one, and then only the new one opens the journal", async () => {
  assert.equal((await api("POST", "/api/passphrase", { current: "wrong horse", next: "new horse battery" })).status, 403);
  assert.equal((await api("POST", "/api/passphrase", { current: "correct horse", next: "new horse battery" })).status, 200);
  await api("POST", "/api/lock");
  assert.equal((await unlock("correct horse")).status, 401);
  assert.equal((await unlock("new horse battery")).status, 200);
  await assert.rejects(vault.open(`${file}.bak`, "correct horse"), vault.WrongPassphrase);
});

test("listed terms go out as placeholders, the prompt says so, and they come back as written", async () => {
  await api("PUT", "/api/settings", { privateTerms: "office = workplace" });
  reply = { content: '{"title":"Lost at workplace A"}' };
  await api("POST", `/api/dreams/${id}/analyze`);
  const dream = dreamIn(await settled(), id);
  assert.equal(dream.sent.messages[1].content, "I was at the workplace A, then home");
  assert.match(dream.sent.messages[0].content, /placeholders such as "Person A"/);
  assert.equal(dream.analysis.title, "Lost at office");
});
