export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// Deterministic 64-bit lookup key from two 32-bit accumulators. Edition and resource identities use SHA-256.
export function fingerprint(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    first = Math.imul(first ^ codeUnit, 0x01000193);
    second = Math.imul(second ^ codeUnit, 0x27d4eb2d);
  }
  return (
    (first >>> 0).toString(36).padStart(7, "0") +
    (second >>> 0).toString(36).padStart(7, "0")
  );
}

export class UniqueIds {
  private readonly occurrences = new Map<string, number>();

  next(base: string): string {
    const count = (this.occurrences.get(base) ?? 0) + 1;
    this.occurrences.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  }
}
