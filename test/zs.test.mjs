import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createClient, ProxyError, readStream } from "../lib/zs.mjs";

// Feeds the given chunks as a byte stream, the way fetch delivers a body.
function streamOf(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

const usage = {
  type: "zs.usage",
  ticket_id: "test-ticket",
  operator_id: 2,
  node_id: 3,
  actual_input_count: 37,
  actual_output_count: 14,
  fee: { total_debit_usd: 0.000375 },
};

test("collects content and the zs.usage frame across split chunks", async () => {
  const sse =
    ": OPENROUTER PROCESSING\n\n" +
    'data: {"choices":[{"delta":{"content":"{\\"title\\":"}}]}\n\n' +
    'data: {"choices":[{"delta":{"reasoning":"hidden"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":" \\"Flight\\"}"},"finish_reason":"stop"}]}\n\n' +
    `event: zs.usage\ndata: ${JSON.stringify(usage)}\n\n` +
    "data: [DONE]\n\n";
  // Split at awkward points, including mid-line and mid-boundary.
  const chunks = [sse.slice(0, 7), sse.slice(7, 60), sse.slice(60, 61), sse.slice(61, 200), sse.slice(200)];
  const out = await readStream(streamOf(chunks));
  assert.equal(out.content, '{"title": "Flight"}');
  assert.equal(out.finish, "stop");
  assert.deepEqual(out.usage, usage);
});

test("handles CRLF line endings and a final event with no trailing blank line", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\r\n\r\n' + `event: zs.usage\r\ndata: ${JSON.stringify(usage)}`;
  const out = await readStream(streamOf([sse]));
  assert.equal(out.content, "ok");
  assert.equal(out.usage.operator_id, 2);
});

test("surfaces an error event from the stream", async () => {
  const sse = 'data: {"error":{"message":"upstream failed","code":502}}\n\n';
  await assert.rejects(readStream(streamOf([sse])), /upstream failed/);
});

const chat = (baseUrl, opts = {}) => createClient({ baseUrl }).chat({ model: "m", messages: [], maxTokens: 1, ...opts });

test("carries the proxy's error code", async (t) => {
  const proxy = http.createServer((req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end('{"error":{"code":"no_relay_available","message":"no relay is available"}}');
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => proxy.close());
  const err = await chat(`http://127.0.0.1:${proxy.address().port}`).catch((e) => e);
  assert.ok(err instanceof ProxyError);
  assert.equal(err.status, 503);
  assert.equal(err.code, "no_relay_available");
});

test("names a proxy that isn't running, or that answers too slowly", async (t) => {
  const closed = http.createServer().listen(0, "127.0.0.1");
  await once(closed, "listening");
  const port = closed.address().port;
  closed.close();
  assert.equal((await chat(`http://127.0.0.1:${port}`).catch((e) => e)).code, "unreachable");

  const silent = http.createServer(() => {});
  silent.listen(0, "127.0.0.1");
  await once(silent, "listening");
  t.after(() => {
    silent.closeAllConnections();
    silent.close();
  });
  assert.equal((await chat(`http://127.0.0.1:${silent.address().port}`, { timeoutMs: 100 }).catch((e) => e)).code, "timeout");
});
