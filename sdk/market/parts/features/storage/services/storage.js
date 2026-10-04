// Service "storage": ctx.storage ("storage" permission), strings per bot
// and plugin, kept in the BotHub database by the core.
//   get(key) -> string | null, set(key, string), has, delete, clear
//   increment(key, by = 1) / decrement -> new number (atomic)
// Keys: 1-128 printable ASCII characters. Store objects as JSON strings.
// Prefix keys with the server ID so servers do not share values.

/** Reads a JSON value, or the fallback when missing or broken. */
export async function readJson(ctx, key, fallback) {
  const raw = await ctx.storage.get(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Stores a JSON value (max 16 KB). */
export async function writeJson(ctx, key, value) {
  await ctx.storage.set(key, JSON.stringify(value));
}
