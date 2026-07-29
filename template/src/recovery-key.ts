import { sha256Hex } from "./security";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_BODY = new RegExp(`^[${CROCKFORD_ALPHABET}]{16}$`);

export function encodeRecoveryKey(bytes: Uint8Array): string {
  if (bytes.byteLength !== 10) {
    throw new Error("recovery_key_requires_10_bytes");
  }

  let buffer = 0;
  let bitCount = 0;
  let body = "";

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      body += CROCKFORD_ALPHABET[(buffer >> bitCount) & 31];
      buffer &= (1 << bitCount) - 1;
    }
  }

  const groups = body.match(/.{4}/g);
  if (groups === null || groups.length !== 4) {
    throw new Error("recovery_key_encoding_failed");
  }
  return `YR-${groups.join("-")}`;
}

export function normalizeRecoveryKey(value: string): string | null {
  const compact = value.toUpperCase().replace(/[\s-]+/g, "");
  if (!compact.startsWith("YR")) return null;

  const body = compact.slice(2);
  if (!RECOVERY_BODY.test(body)) return null;

  return `YR-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
}

export function isRecoveryKey(value: string): boolean {
  return normalizeRecoveryKey(value) !== null;
}

export async function hashRecoveryKey(value: string): Promise<string | null> {
  const normalized = normalizeRecoveryKey(value);
  return normalized === null ? null : sha256Hex(normalized);
}
