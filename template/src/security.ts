const HEX_SHA256 = /^[0-9a-f]{64}$/;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToBytes(value: string): Uint8Array | null {
  if (!HEX_SHA256.test(value)) return null;

  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    const offset = index * 2;
    bytes[index] = Number.parseInt(value.slice(offset, offset + 2), 16);
  }
  return bytes;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToHex(new Uint8Array(digest));
}

export async function secureEqual(
  provided: string,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

export function secureEqualHex(provided: string, expected: string): boolean {
  const providedBytes = hexToBytes(provided);
  const expectedBytes = hexToBytes(expected);
  if (providedBytes === null || expectedBytes === null) return false;

  return crypto.subtle.timingSafeEqual(providedBytes, expectedBytes);
}

export function randomId(): string {
  return crypto.randomUUID();
}
