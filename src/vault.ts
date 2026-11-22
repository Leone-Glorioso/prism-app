// Passphrase encryption for data kept in the browser (token, unsaved drafts): PBKDF2-SHA256 -> AES-256-GCM.
// Protects against someone copying the browser's storage (another site on the same origin, a backup, a
// shared profile). It cannot protect against code running inside this page while it is unlocked.

import { bytesToBase64 } from './util';

export interface Sealed {
  v: 1;
  salt: string;
  iv: string;
  ct: string;
}

export class WrongPassphrase extends Error {
  constructor() {
    super('Wrong passphrase, or the stored data is damaged.');
  }
}

// OWASP (2023) recommendation for PBKDF2-HMAC-SHA256.
const ITERATIONS = 600_000;
const AAD = new TextEncoder().encode('prism-vault-v1');

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function newSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(key: CryptoKey, salt: Uint8Array, data: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // fresh for every write
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(JSON.stringify(data))));
  return { v: 1, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ct: bytesToBase64(ct) };
}

export async function unseal(key: CryptoKey, sealed: Sealed): Promise<unknown> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(sealed.iv), additionalData: AAD }, key, fromB64(sealed.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new WrongPassphrase();
  }
}

export async function unlock(passphrase: string, sealed: Sealed): Promise<{ key: CryptoKey; salt: Uint8Array; data: unknown }> {
  if (sealed?.v !== 1) throw new WrongPassphrase();
  const salt = fromB64(sealed.salt);
  const key = await deriveKey(passphrase, salt);
  return { key, salt, data: await unseal(key, sealed) };
}

export function isSealed(x: unknown): x is Sealed {
  const s = x as Sealed | null;
  return !!s && s.v === 1 && typeof s.salt === 'string' && typeof s.iv === 'string' && typeof s.ct === 'string';
}
