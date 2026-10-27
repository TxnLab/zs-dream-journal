# Dream journal

A private dream journal that runs on your computer. Each entry is encrypted with your passphrase
before anything else happens, then analyzed and catalogued by a model on
[ZeroSignal](https://docs.zerosignal.ai) through the local `zs-proxy`.

It's also a sample app. [GUIDE.md](GUIDE.md) walks through how it's built, one decision at a time,
so you can reuse the parts for your own app on ZeroSignal.

## Run it

You need Node 24 or later, and [`zs-proxy`](https://docs.zerosignal.ai/using-the-proxy/quick-start)
installed, funded and running on this machine (default `http://127.0.0.1:9376`).

```sh
zs-proxy status   # "ready: yes" means it can pay for requests
npm start
```

Open http://127.0.0.1:5177, choose a passphrase, and write down last night's dream. There's nothing
to install: the app has no dependencies.

| Variable | Default | What it sets |
| --- | --- | --- |
| `PORT` | `5177` | Where the app listens (always on 127.0.0.1) |
| `ZS_PROXY_URL` | `http://127.0.0.1:9376` | The zs-proxy to send analysis through |
| `DREAM_JOURNAL_FILE` | `~/.zs-dream-journal/journal.enc` | The encrypted journal |

`npm test` runs the tests.

## What happens to a dream

1. **It's encrypted and saved first.** The journal is one file, encrypted with AES-256-GCM using a key
   derived from your passphrase with scrypt. Plaintext exists only in the app's memory while unlocked.
   The app locks itself after 15 idle minutes by default. The passphrase can't be recovered, but you
   can change it in Settings, where you can also export an unencrypted copy.
   Analysis runs in the background, so you can keep writing while it works, and you can edit an
   entry later without resending it.
2. **Only the text goes out.** The dream is sent as you wrote it. The date, your other dreams and your
   settings are never sent. If there's a name or place you'd rather keep back too, list it under
   Private terms in Settings. It becomes a placeholder such as `Person A` or `workplace A` before the
   request is built, and is swapped back when the analysis returns. The list starts empty, and nothing
   needs to be on it for the app to work.
3. **The proxy seals it and sends it through a relay.** "Require a relay" is on by default, so the
   operator running the model never sees your IP address, and the relay that carries the request can't
   read it. If no relay is available, the request fails instead of going direct.
4. **The catalog is built here.** Tags, symbols, emotions, search and filters all come from each
   dream's stored analysis, so cataloguing never resends anything. "Find patterns" sends only the
   titles, tags and symbols of your analyzed dreams, numbered rather than dated.
5. **Every request gets a receipt.** Each analysis shows which operator and node served it, the tokens,
   the exact cost and the on-chain ticket. "Exactly what left this computer" shows the request body,
   so you can check it for yourself. Settings has a ledger of every paid request.

## Who can see what

- **The operator** that runs the model reads the text it analyzes (it has to, to answer), including
  any names in it apart from the private terms you listed. It doesn't get your IP address, and
  there's no account with your name on it.
- **The relay** sees your IP address, but the request is sealed, so it can't read the dream.
- **Payments are public on-chain.** Each request is paid from the proxy's wallet, so an operator could
  tell that several requests came from the same wallet, though not whose wallet it is.
- **Operators declare their own retention.** "Require attested hardware" in Settings limits analysis to
  operators whose confidential-compute attestation the proxy verified itself. Few models qualify today.

## Cost

A dream typically costs well under a tenth of a cent to analyze. On 2026-10-27, test analyses cost:

| Model | Served by | Cost |
| --- | --- | --- |
| `anthropic/claude-haiku-5.5` (default) | operator 4 | $0.00085 |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | operator 2 | $0.000375 |
| `glm-5.3-flash` | operator 1 | $0.0003 |

Pick any model from the live catalog in Settings.

## Layout

- `server.mjs`: the local HTTP server and API. It accepts requests only for 127.0.0.1 or localhost,
  needs a session token from unlock, and refuses cross-origin writes.
- `lib/vault.mjs`: encryption at rest.
- `lib/zs.mjs`: the proxy client, including the `zs.usage` frame that carries each receipt.
- `lib/dreams.mjs`: prompts, placeholders, and normalization of the model's reply.
- `public/`: the page. It loads nothing from anywhere but this server: no fonts, CDNs or analytics.

## License

[MIT](LICENSE)
