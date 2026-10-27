import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vault from "../lib/vault.mjs";

async function tempFile(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dream-vault-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "journal.enc");
}

test("round-trips data and keeps no plaintext on disk", async (t) => {
  const file = await tempFile(t);
  const data = { dreams: [{ text: "I was flying over a flooded library" }] };
  vault.close(await vault.create(file, "correct horse battery", data));

  const raw = await readFile(file, "utf8");
  assert.ok(!raw.includes("flooded library"));

  const { vault: v, data: back } = await vault.open(file, "correct horse battery");
  assert.deepEqual(back, data);
  vault.close(v);
});

test("rejects a wrong passphrase", async (t) => {
  const file = await tempFile(t);
  vault.close(await vault.create(file, "correct horse battery", { dreams: [] }));
  await assert.rejects(vault.open(file, "wrong horse battery"), vault.WrongPassphrase);
});

test("each save uses a fresh IV and keeps a backup", async (t) => {
  const file = await tempFile(t);
  const v = await vault.create(file, "correct horse battery", { n: 1 });
  const first = JSON.parse(await readFile(file, "utf8"));
  await vault.save(v, { n: 2 });
  const second = JSON.parse(await readFile(file, "utf8"));
  assert.notEqual(first.iv, second.iv);
  assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, "utf8")), first);
  vault.close(v);
});

test("verifies the passphrase a vault was opened with", async (t) => {
  const file = await tempFile(t);
  const v = await vault.create(file, "correct horse battery", { n: 1 });
  assert.equal(await vault.verify(v, "correct horse battery"), true);
  assert.equal(await vault.verify(v, "wrong horse battery"), false);
  vault.close(v);
});

test("a new passphrase re-encrypts the journal and its backup, and the old one opens neither", async (t) => {
  const file = await tempFile(t);
  const v = await vault.create(file, "correct horse battery", { n: 1 });
  await vault.save(v, { n: 2 });
  await vault.rekey(v, "new horse battery", { n: 3 });
  for (const f of [file, `${file}.bak`]) {
    await assert.rejects(vault.open(f, "correct horse battery"), vault.WrongPassphrase);
    const { vault: opened, data } = await vault.open(f, "new horse battery");
    assert.deepEqual(data, { n: 3 });
    vault.close(opened);
  }
  assert.equal(await vault.verify(v, "new horse battery"), true);
  vault.close(v);
});

test("refuses to save once closed, so a zeroed key never overwrites the journal", async (t) => {
  const file = await tempFile(t);
  const v = await vault.create(file, "correct horse battery", { n: 1 });
  vault.close(v);
  await assert.rejects(vault.save(v, { n: 2 }), /locked/);
  const { data } = await vault.open(file, "correct horse battery");
  assert.deepEqual(data, { n: 1 });
});
