/** Trimmed and in Unicode NFC, so text that looks the same is stored the same. */
export function canonicalText(value: unknown): unknown {
  return typeof value === 'string' ? value.normalize('NFC').trim() : value;
}

/** Length in Unicode code points: not UTF-16 units, not grapheme clusters. */
export function codePointLength(value: string): number {
  return [...value].length;
}
