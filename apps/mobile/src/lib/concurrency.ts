/**
 * Bounded-concurrency map (pure control flow, m0.8.1). Several paths ran
 * per-item native round trips in a plain `for … await` loop — History
 * reconciled a 40-row page with 80 SERIALIZED MediaStore calls, and edit
 * detection paged MediaStore once per queued photo. Concurrency is
 * bounded (never unbounded `Promise.all` over a user-sized list) so a
 * long queue cannot flood the native bridge.
 *
 * Results keep INPUT order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}
