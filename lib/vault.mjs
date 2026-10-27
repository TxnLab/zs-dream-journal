// The journal at rest: one JSON envelope holding AES-256-GCM ciphertext, keyed
// by scrypt from the passphrase. Plaintext only ever exists in memory.
import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const FORMAT = "zs-dream-journal";
const AAD = Buffer.from(FORMAT);
const KDF = { N: 2 ** 16, r: 8, p: 1 };
const KEY_BYTES = 32;

export class WrongPassphrase extends Error {}

function deriveKey(passphrase, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    // maxmem must cover 128 * N * r bytes, which is 64 MiB at the defaults.
    scrypt(passphrase.normalize("NFKC"), salt, KEY_BYTES, { N, r, p, maxmem: 256 * 2 ** 20 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function create(file, passphrase, data) {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, KDF);
  const vault = { file, key, kdf: { alg: "scrypt", ...KDF, salt: salt.toString("base64") }, closed: false };
  await save(vault, data);
  return vault;
}

export async function open(file, passphrase) {
  const env = JSON.parse(await fs.readFile(file, "utf8"));
  if (env.format !== FORMAT || env.v !== 1 || env.kdf?.alg !== "scrypt") throw new Error(`${file} is not a dream journal`);
  const key = await deriveKey(passphrase, Buffer.from(env.kdf.salt, "base64"), env.kdf);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  let plain;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(env.data, "base64")), decipher.final()]);
  } catch {
    key.fill(0);
    throw new WrongPassphrase("Wrong passphrase.");
  }
  const data = JSON.parse(plain.toString("utf8"));
  plain.fill(0);
  return { vault: { file, key, kdf: env.kdf, closed: false }, data };
}

// Writes a temp file and renames it over the journal, keeping the previous
// version as .bak, so a crash mid-write never leaves a half-written journal.
export async function save(vault, data) {
  // A closed vault's key is zeroed; encrypting with it would make the file
  // unreadable with the real passphrase.
  if (vault.closed) throw new Error("The journal is locked.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vault.key, iv);
  cipher.setAAD(AAD);
  const plain = Buffer.from(JSON.stringify(data), "utf8");
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  plain.fill(0);
  const env = {
    format: FORMAT,
    v: 1,
    kdf: vault.kdf,
    cipher: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ct.toString("base64"),
  };
  await fs.mkdir(path.dirname(vault.file), { recursive: true });
  const tmp = `${vault.file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(env), { mode: 0o600 });
  if (await exists(vault.file)) await fs.copyFile(vault.file, `${vault.file}.bak`);
  await fs.rename(tmp, vault.file);
}

// Whether this is the passphrase the vault's key came from.
export async function verify(vault, passphrase) {
  const key = await deriveKey(passphrase, Buffer.from(vault.kdf.salt, "base64"), vault.kdf);
  const same = timingSafeEqual(key, vault.key);
  key.fill(0);
  return same;
}

// Re-encrypts the journal under a new passphrase, with a new salt.
export async function rekey(vault, passphrase, data) {
  if (vault.closed) throw new Error("The journal is locked.");
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, KDF);
  const kdf = { alg: "scrypt", ...KDF, salt: salt.toString("base64") };
  await save({ ...vault, key, kdf }, data);
  // The journal now opens only with the new passphrase.
  vault.key.fill(0);
  Object.assign(vault, { key, kdf });
  // The .bak copy is still under the old one. Saving again replaces it, so the
  // old passphrase opens nothing.
  await save(vault, data);
}

export function close(vault) {
  vault.closed = true;
  vault.key.fill(0);
}
