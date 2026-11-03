import type { JsonRecord, JsonValue } from './schema.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeColor(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { r, g, b } = value;
  if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number') return undefined;
  const hasAlpha = typeof value.a === 'number';
  const a = hasAlpha ? value.a as number : undefined;
  const channel = (number: number): string => Math.round(Math.max(0, Math.min(1, number)) * 255).toString(16).padStart(2, '0');
  const hex = `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase();
  const color: JsonRecord = {
    r,
    g,
    b,
    hex,
    rgb: [r * 255, g * 255, b * 255]
  };
  if (a !== undefined) {
    color.a = a;
    color.hex8 = `${hex}${channel(a)}`;
    color.rgba = [r * 255, g * 255, b * 255, a];
  }
  return color;
}

export function toJsonValue(value: unknown, mixedSentinel?: unknown, seen = new WeakSet<object>()): JsonValue | undefined {
  if (mixedSentinel !== undefined && value === mixedSentinel) return { mixed: true };
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    for (const item of value) {
      const normalized = toJsonValue(item, mixedSentinel, seen);
      output.push(normalized === undefined ? null : normalized);
    }
    return output;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return { circularReference: true };
    seen.add(value);
    const color = normalizeColor(value);
    if (color) {
      seen.delete(value);
      return color;
    }
    const output: JsonRecord = {};
    for (const key of Object.keys(value)) {
      let field: unknown;
      try {
        field = (value as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      const normalized = toJsonValue(field, mixedSentinel, seen);
      if (normalized !== undefined) output[key] = normalized;
    }
    seen.delete(value);
    return output;
  }
  return undefined;
}

export function canonicalJson(value: JsonValue): string {
  const sort = (current: JsonValue): JsonValue => {
    if (Array.isArray(current)) return current.map(sort);
    if (current && typeof current === 'object') {
      const result: JsonRecord = {};
      for (const key of Object.keys(current).sort()) result[key] = sort(current[key] as JsonValue);
      return result;
    }
    return current;
  };
  return JSON.stringify(sort(value));
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
