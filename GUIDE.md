# Building a private app on ZeroSignal

This guide walks through the dream journal as a template for apps that send sensitive text to a
model on [ZeroSignal](https://docs.zerosignal.ai). Dreams make a good test case. They're personal,
full of real names, and most people would never paste them into a chat service that keeps logs.

Each section covers one decision, points at the code that makes it, and says what to carry over to
your own app. The app has no dependencies, so the code you read is all the code there is: about 500
lines of server, about 400 of library, and a plain-DOM page.

1. [Run the proxy](#1-run-the-proxy)
2. [Call it like any OpenAI endpoint](#2-call-it-like-any-openai-endpoint)
3. [Keep a receipt for every request](#3-keep-a-receipt-for-every-request)
4. [Choose the route: relays and attested hardware](#4-choose-the-route-relays-and-attested-hardware)
5. [Send less than you have](#5-send-less-than-you-have)
6. [Ask for JSON, then check it](#6-ask-for-json-then-check-it)
7. [Encrypt what you keep](#7-encrypt-what-you-keep)
8. [Lock down the local server](#8-lock-down-the-local-server)
9. [Show people what left their computer](#9-show-people-what-left-their-computer)
10. [Adapting it](#10-adapting-it)

## 1. Run the proxy

The app never talks to the network itself. It talks to `zs-proxy`, a single-user daemon on your
machine that exposes a plain OpenAI `/v1` API. For each request, the proxy encrypts it, picks an
operator to run the model and a relay to carry it, and pays for it from your wallet. There's no API
key: each request is paid for on-chain, a fraction of a cent at a time.

Install it ([full quick start](https://docs.zerosignal.ai/using-the-proxy/quick-start)):

```sh
# macOS
brew install txnlab/tap/zs-proxy

# Linux
curl -fsSL https://zerosignal.ai/install.sh | sh

# Windows
scoop bucket add txnlab https://github.com/txnlab/scoop-bucket
scoop install zs-proxy
```

Sign in, start it, and check that it can pay:

```sh
zs-proxy wallet login
zs-proxy proxy start
zs-proxy status
```

`status` should show a `USDC:` balance and `ready: yes`. The proxy runs on mainnet, so requests
cost real money. Add funds at [zerosignal.ai](https://zerosignal.ai). Until you do, every request
fails with `402 wallet_unfunded`.

The proxy listens on `http://127.0.0.1:9376`. With it running:

```sh
npm start
```

Open http://127.0.0.1:5177, choose a passphrase, and write something down.

## 2. Call it like any OpenAI endpoint

Any OpenAI client works against the proxy with base URL `http://127.0.0.1:9376/v1` and any API key.
This app uses `fetch` directly, so every field is visible. From [lib/zs.mjs](lib/zs.mjs):

```js
const body = { model, messages, max_tokens: maxTokens, stream: true };
if (reasoningEffort) body.reasoning_effort = reasoningEffort;
if (relay) body.provider = { relay };
const headers = { "Content-Type": "application/json", "X-Zs-Usage-Frame": "1" };
if (requireTee) headers["X-Zs-Require-TEE"] = "1";
const res = await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
```

That's a standard chat completion request plus three ZeroSignal additions, covered in the next two
sections: `provider`, `X-Zs-Require-TEE` and `X-Zs-Usage-Frame`.

`GET /v1/models` returns the live catalog: each model's price per token, context length, and the
reasoning efforts it accepts. `liveModels` in [server.mjs](server.mjs) caches it for five minutes,
fills the model picker in Settings from it, and asks for `reasoning_effort: "low"` when the model
allows it. The reply is a small JSON object, so long reasoning would cost more without helping.

`GET /healthz` answers when the proxy is up. The app checks it on the lock screen and, if the proxy
isn't answering, says that writing still works but analysis needs the proxy.

## 3. Keep a receipt for every request

Every request is paid for separately, so the app can tell people exactly what each one cost and who
served it. A whole (non-streamed) reply carries this in `X-Zs-*` response headers. A stream sends
its headers before the cost is known, so with `X-Zs-Usage-Frame` set the proxy adds one more
server-sent event at the end of the stream:

```
event: zs.usage
data: {"type":"zs.usage","ticket_id":"...","operator_id":...,"node_id":...,...}
```

The fields this app keeps:

| Field | Meaning |
| --- | --- |
| `operator_id`, `node_id` | The operator and machine that ran the model |
| `ticket_id` | The on-chain ticket that paid for the request |
| `actual_input_count`, `actual_output_count` | Tokens billed |
| `inference.amount_usd` | The model's charge |
| `fee.total_debit_usd` | Everything taken from the wallet for this request |

The frame is opt-in because it isn't an OpenAI chunk, and strict OpenAI clients fail on it. If you
use an OpenAI SDK with streaming, leave the header off and read costs elsewhere, or parse the stream
yourself. `readStream` in [lib/zs.mjs](lib/zs.mjs) does the latter in about 50 lines. It handles the
cases that break naive parsers: events split across network chunks, CRLF line endings, a final event
with no trailing blank line, and error events mid-stream. Each has a test in
[test/zs.test.mjs](test/zs.test.mjs).

`callModel` in [server.mjs](server.mjs) turns each frame into a receipt, stores it on the dream, and
appends it to a ledger inside the encrypted journal. The page shows the receipt under each
analysis, the running total in the top bar, and the full ledger in Settings.

## 4. Choose the route: relays and attested hardware

Every request is split between two parties. The **relay** carries the sealed request: it sees your
IP address and can't read a word. The **operator** runs the model: it reads the text it has to
answer, and never learns whose request it is. Neither one has both halves.

### Require a relay

Without a preference, the proxy follows its own configuration. A journal shouldn't depend on how
someone configured their proxy, so the app sets the relay per request:

```js
if (relay) body.provider = { relay }; // relay is "required"
```

With `"required"`, the proxy fails with `503 no_relay_available` rather than send the request
directly. The proxy reads `provider` and strips it before sealing, so the operator never sees it.
(The `X-Zs-Relay` header does the same thing. If both are set, the body wins.) "Require a relay" is
on by default in Settings.

### Require attested hardware

`X-Zs-Require-TEE: 1` limits the request to operators whose confidential-compute attestation your
proxy verified itself. An operator advertising a TEE doesn't count until your proxy has checked it.
The header never leaves your machine, and it never falls back: if no attested operator serves the
model, you get `503 no_tee_capacity`.

Few models qualify today, so the app leaves this off by default and offers it as a setting, with a
warning that analysis may fail with it on.

Both preferences apply per request, so an app can set them per feature. See
[routing preferences](https://docs.zerosignal.ai/reference/routing-preferences) for the rest, such
as pinning operators and price ceilings.

### Say what failed, in plain words

When the proxy can't meet a preference, or can't pay, its error body carries a code:
`no_relay_available`, `no_tee_capacity`, `wallet_unfunded`. [lib/zs.mjs](lib/zs.mjs) keeps that
code on the `ProxyError` it throws, and adds `unreachable` and `timeout` for a proxy that never
answered. `explain` in [server.mjs](server.mjs) turns each one into a sentence that says what to do
next. Where the proxy refused before sending, as it does for a missing relay or attested operator,
the message also says nothing was sent. That's the reassurance people need most when a privacy
preference stops a request.

## 5. Send less than you have

The operator has to read what it analyzes. So the useful question is how little it needs to read.

**Only the text.** An analysis request is the system prompt and the dream's text. The date, the
other dreams and the settings stay on the machine.

**Optionally, private terms become placeholders.** The list starts empty, and the app works without
it: the dream goes out as written. People who'd rather keep a name back list it in Settings, one per
line:

```
Sarah
Acme Corp = workplace
```

Before the request is built, `pseudonymize` in [lib/dreams.mjs](lib/dreams.mjs) replaces each one,
and `restore` swaps them back into the reply:

```
I was back at Acme Corp and Sarah handed me a key.
I was back at workplace A and Person A handed me a key.
```

The details that make this hold up:

- Whole words only, Unicode-aware, so `Al` never matches inside `Alice`.
- Longest term first, so `Mary Ann` is replaced before `Mary`.
- Restoring is case-insensitive, because models sometimes lowercase a placeholder.
- When something was swapped, `systemPrompt` tells the model to keep placeholders exactly as
  written and never guess what they stand for. When nothing was, the prompt doesn't mention
  placeholders, so it never describes a dream as something it isn't.

This catches the terms someone listed, not every identifying detail in free text. It's a
mitigation, not anonymization, and your own app should say so where people set it up.

**Summaries for questions across entries.** "Find patterns" doesn't resend any dreams.
`patternSummaries` sends only what the earlier analyses already produced (title, type, emotions,
themes, symbols, places), numbered rather than dated. A test in
[test/dreams.test.mjs](test/dreams.test.mjs) checks that no dream text or date gets in.

## 6. Ask for JSON, then check it

Tags, filters and search are built on the machine from each dream's stored analysis, so
cataloguing never sends anything. That needs a fixed shape, so the analysis prompt asks for one JSON
object and spells out every field. Models don't always comply. Some wrap the answer in prose or a
`<think>` block, and some invent fields or overrun limits. So the app treats the reply as untrusted
input:

- `extractJson` drops `<think>` blocks and parses the outermost `{...}`.
- `normalizeAnalysis` checks every field: string lengths, list sizes, the allowed dream types,
  vividness from 1 to 5, and a default for anything missing.
- If parsing fails, the dream keeps the raw reply and an error, and the page offers "Analyze again"
  or a different model. The entry itself is safe: it's saved before anything is sent.
- A reply that stops with `finish_reason: "length"` hit `max_tokens` partway through the object.
  The app says so rather than calling it bad JSON. The limit is set high (`MAX_TOKENS` in
  [server.mjs](server.mjs)) because reasoning models spend part of it thinking. It's a ceiling, not
  a target: the receipt bills the tokens actually used.

The page inserts every string from the journal or a model as text, never as HTML (the `h` helper in
[public/app.js](public/app.js)), so a reply can't inject markup.

## 7. Encrypt what you keep

None of the above helps if the journal sits in plaintext on disk. [lib/vault.mjs](lib/vault.mjs)
keeps it as one encrypted file:

- The key comes from the passphrase through scrypt (N = 2^16, r = 8, p = 1) with a random salt.
- Each save uses AES-256-GCM with a fresh 12-byte IV. The auth tag means a wrong passphrase and a
  tampered file both fail loudly instead of decrypting to garbage.
- The file is a small JSON envelope that records the format, version and KDF parameters, so they
  can change later without breaking old journals.
- Saves write a temp file, keep the previous version as `.bak`, then rename. A crash mid-write never
  leaves a half-written journal. The server also queues saves so two can't race.
- Locking zeroes the key, and saving with a locked vault throws, because encrypting with a zeroed
  key would make the file unreadable.
- Analysis runs in the background. Saving a dream returns as soon as it's encrypted, and the page
  polls until the analysis lands.
- The page locks itself after 15 idle minutes by default, and locks the server with it, so a
  journal left open doesn't stay on screen. Reading needs no requests, so while someone is active
  the page pings the server about once a minute. If the page goes away, the server locks on its own.
- Locking stops the session token at once. An analysis already under way has been paid for, so it
  still finishes and saves before the key is wiped. Unlocking again waits for that, and unlocking
  from a second tab rejoins the open session instead of rereading the file.

The passphrase can't be recovered. That's the trade for nobody else being able to open the file.
It can be changed, though. `rekey` encrypts the journal under a new salt and key, then saves a
second time, because the first save leaves the previous file as `.bak`, still under the old
passphrase.

## 8. Lock down the local server

A server on `127.0.0.1` is reachable from every web page open in the same browser. [server.mjs](server.mjs)
assumes some of them are hostile:

- It listens on `127.0.0.1` only.
- It rejects any `Host` header other than `127.0.0.1:PORT` or `localhost:PORT`. That stops DNS
  rebinding, where an outside site points its own hostname at your machine.
- It refuses API writes whose `Origin` isn't this app, so another site can't drive the API from
  your browser.
- Every call after unlock needs a session token in a custom `X-Session` header, compared in
  constant time. A cross-site form can't set that header.
- The page is served with a Content-Security-Policy of `default-src 'none'`, then `'self'` for
  scripts, styles and connections. No fonts, CDNs or analytics load from anywhere else.
- Request bodies are capped at 1 MB.

## 9. Show people what left their computer

Privacy claims are easier to trust when people can check them. Each analysis stores `sent`: the
request body the app handed the proxy, minus `provider`, which the proxy strips before sealing. The
page shows it under "Exactly what left this computer", so anyone can confirm what was sent,
and that any private terms were swapped out. (The proxy may add routing fields such as `store: false` before sealing. It doesn't
change the messages.)

Together with the receipt, every request answers four questions: what was sent, who served it,
what it cost, and which on-chain ticket paid for it.

## 10. Adapting it

For your own app, the parts carry over roughly in this order:

- [ ] Point your client at `http://127.0.0.1:9376/v1`. Any OpenAI SDK works, with any API key.
- [ ] Decide per feature whether to require a relay (`provider.relay: "required"`) or attested
      hardware (`X-Zs-Require-TEE`), and handle the `503` each one returns when it can't be met.
- [ ] Work out what the model actually needs to read, and send only that.
- [ ] Let people list identifying terms to replace with placeholders on the way out and restore on
      the way back.
- [ ] Opt into the `zs.usage` frame (or read the `X-Zs-*` headers) and keep the receipts.
- [ ] Treat model output as untrusted input. Validate its shape and keep the raw reply on failure.
- [ ] Encrypt anything you store with a key only the user holds.
- [ ] If you run a local server, check `Host` and `Origin` and require a token.

Where things live:

| File | What it does |
| --- | --- |
| [server.mjs](server.mjs) | HTTP server, API routes, sessions, auto-lock, the model call and its receipt |
| [lib/zs.mjs](lib/zs.mjs) | Proxy client and SSE parser, including the `zs.usage` frame |
| [lib/dreams.mjs](lib/dreams.mjs) | Prompts, placeholders, JSON extraction and normalization |
| [lib/vault.mjs](lib/vault.mjs) | Encryption at rest |
| [public/](public/) | The page: plain DOM, no dependencies |
| [test/](test/) | `npm test`, using Node's built-in test runner |

## Further reading

- [Life of a request](https://docs.zerosignal.ai/concepts/life-of-a-request)
- [Relays](https://docs.zerosignal.ai/concepts/relays)
- [Confidential compute](https://docs.zerosignal.ai/concepts/confidential-compute) and
  [verifying attestation](https://docs.zerosignal.ai/concepts/verifying-attestation)
- [Proxy configuration](https://docs.zerosignal.ai/using-the-proxy/configuration)
- [Routing preferences](https://docs.zerosignal.ai/reference/routing-preferences)
