// One-off local helper: node scripts/hash-password.mjs "your password"
// Prints a salt:hash pair in the exact format src/auth.ts's verifyPassword
// expects. Run this locally — never send a plaintext password anywhere else.
import { webcrypto } from "node:crypto";

const PBKDF2_ITERATIONS = 100_000;

function toHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

async function hashPassword(password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `${toHex(salt)}:${toHex(new Uint8Array(bits))}`;
}

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.mjs "your password"');
  process.exit(1);
}

hashPassword(password).then((hash) => console.log(hash));
