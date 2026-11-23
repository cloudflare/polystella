export async function runWithConcurrency<T>(
  items: ReadonlyArray<T>,
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function runner(): Promise<void> {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      if (item !== undefined) await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, runner));
}
