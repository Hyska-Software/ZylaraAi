/** Serializes host owner props for sandboxed plugin frames. */

const MAX_STRING = 64 * 1024;
const MAX_DEPTH = 8;

export function toPluginContext(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, 200)
      .map((entry) => toPluginContext(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(source)) {
      if (count >= 80) break;
      const serialized = toPluginContext(entry, depth + 1);
      if (serialized === undefined) continue;
      result[key] = serialized;
      count += 1;
    }
    return result;
  }
  return null;
}

export function pluginContextRecord(value: unknown): Record<string, unknown> {
  const serialized = toPluginContext(value);
  return serialized && typeof serialized === 'object' && !Array.isArray(serialized)
    ? (serialized as Record<string, unknown>)
    : {};
}
