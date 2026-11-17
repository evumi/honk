// Keeps object identity across reloads: an item equal to the one already
// shown is kept as that object, so lists leave its row alone instead of
// rendering it again (a reload after every push or read receipt would
// otherwise rebuild every visible row, cards included).

/** `next`, with each item that equals the one of the same key in `prev` replaced by that one. */
export function reuse<T>(prev: readonly T[], next: readonly T[], key: (item: T) => string): T[] {
  if (prev.length === 0) return [...next];
  const old = new Map<string, { item: T; json: string }>();
  for (const item of prev) old.set(key(item), { item, json: "" });
  return next.map((item) => {
    const o = old.get(key(item));
    if (!o) return item;
    if (o.json === "") o.json = JSON.stringify(o.item);
    return o.json === JSON.stringify(item) ? o.item : item;
  });
}
