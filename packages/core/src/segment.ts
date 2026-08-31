/** Smallest independently translated unit, identified for response matching. */
export interface Segment {
  /** Unique within one translation input. */
  id: string;
  text: string;
}

export function assertUniqueSegmentIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`[polystella] duplicate segment id "${id}"`);
    seen.add(id);
  }
}
