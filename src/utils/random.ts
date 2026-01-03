export function pickRandom<T>(items: T[]): T | undefined {
  if (items.length === 0) return undefined;
  const idx = Math.floor(Math.random() * items.length);
  return items[idx];
}


