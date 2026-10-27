// A small client for the local zs-proxy. Chat requests stream, and opt into the
// proxy's zs.usage frame, which names the operator that served the request,
// its on-chain ticket, and exactly what it cost.

// `code` is the proxy's error code, such as "no_relay_available", or
// "unreachable" or "timeout" when the proxy never answered.
export class ProxyError extends Error {
  constructor(message, { status = null, code = "" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function answered(res) {
  const body = await res.text();
  let code = "";
  let message = body;
  try {
    const j = JSON.parse(body);
    code = String(j.error?.code ?? j.code ?? "");
    message = j.error?.message ?? j.message ?? body;
  } catch {}
  return new ProxyError(`ZeroSignal proxy answered ${res.status}${code ? ` (${code})` : ""}: ${String(message).slice(0, 400)}`, {
    status: res.status,
    code,
  });
}

// fetch fails with a bare "fetch failed" when nothing is listening, and with a
// TimeoutError when the deadline passes, before or during the reply.
function unanswered(err, baseUrl) {
  if (err instanceof ProxyError) return err;
  if (err.name === "TimeoutError") return new ProxyError(`No answer from the ZeroSignal proxy at ${baseUrl} in time.`, { code: "timeout" });
  return new ProxyError(`Couldn't reach the ZeroSignal proxy at ${baseUrl}: ${err.cause?.code ?? err.message}`, { code: "unreachable" });
}

export function createClient({ baseUrl }) {
  async function get(p, timeoutMs = 15000) {
    const res = await fetch(baseUrl + p, { signal: AbortSignal.timeout(timeoutMs) }).catch((err) => {
      throw unanswered(err, baseUrl);
    });
    if (!res.ok) throw await answered(res);
    return res.json();
  }
  return {
    healthy: () => get("/healthz", 2000).then(() => true, () => false),
    models: () => get("/v1/models").then((j) => j.data ?? []),
    chat: (opts) => chat(baseUrl, opts),
  };
}

// Returns the reply text, the zs.usage frame, and the body that was sent. The
// proxy reads `provider` and the TEE header to pick an operator, then strips
// both before the sealed request leaves the machine.
async function chat(baseUrl, { model, messages, maxTokens, relay, requireTee, reasoningEffort, timeoutMs = 240_000 }) {
  const body = { model, messages, max_tokens: maxTokens, stream: true };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (relay) body.provider = { relay };
  const headers = { "Content-Type": "application/json", "X-Zs-Usage-Frame": "1" };
  if (requireTee) headers["X-Zs-Require-TEE"] = "1";
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw await answered(res);
    const { content, usage, finish } = await readStream(res.body);
    return { content, usage, finish, body };
  } catch (err) {
    throw unanswered(err, baseUrl);
  }
}

export async function readStream(stream) {
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let usage = null;
  let finish = null;

  const handle = (event, data) => {
    if (data === "[DONE]") return;
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (event === "zs.usage" || j.type === "zs.usage") {
      usage = j;
      return;
    }
    if (j.error) {
      const code = String(j.error.code ?? "");
      throw new ProxyError(`The reply stream failed${code ? ` (${code})` : ""}: ${String(j.error.message ?? data).slice(0, 400)}`, { status: 502, code });
    }
    const choice = j.choices?.[0];
    if (choice?.delta?.content) content += choice.delta.content;
    if (choice?.finish_reason) finish = choice.finish_reason;
  };

  const drain = (final) => {
    buf = buf.replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0 || (final && buf.trim())) {
      const block = i >= 0 ? buf.slice(0, i) : buf;
      buf = i >= 0 ? buf.slice(i + 2) : "";
      let event = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) handle(event, data.join("\n"));
    }
  };

  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    drain(false);
  }
  buf += decoder.decode();
  drain(true);
  return { content, usage, finish };
}
