# Security

This is a sample app, but it holds something people would hate to see leaked, so we take reports
seriously.

## Reporting a vulnerability

Report it privately: open this repository's **Security** tab and choose **Report a vulnerability**.
Please don't open a public issue.

Say what you found, how to reproduce it, and what someone could do with it.

## What counts

- **Encryption at rest** ([lib/vault.mjs](lib/vault.mjs)): anything that reveals a journal, or its
  `.bak` copy, without the passphrase.
- **The local server** ([server.mjs](server.mjs)): another web page or program reading or changing
  the journal, or getting past the session token or the `Host` and `Origin` checks.
- **What leaves the computer**: a request that carries something the app says it doesn't send,
  such as the date, another dream, or a term listed under Private terms.
- **The page** ([public/](public/)): script running from a dream's text or from the model's reply.

## What doesn't

- `zs-proxy`, relays, operators and the rest of the ZeroSignal network. This repo only uses them.
  If you can't tell which side a problem is on, report it here anyway.
- Someone using a computer while the journal is unlocked on it.
- The operator reading the text it analyzes. That's how analysis works, and the README's
  "Who can see what" section says so.
