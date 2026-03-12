// utils/stringifyTree.js
export function stringifyTree(value, { pretty = false, sortKeys = true } = {}) {
  const seen = new WeakSet();

  const normalizeObject = (obj) => {
    if (!sortKeys || Array.isArray(obj)) return obj;
    const out = {};
    for (const k of Object.keys(obj).sort()) out[k] = obj[k];
    return out;
  };

  const replacer = (key, val) => {
    // Drop undefined/functions/symbols (JSON does this for objects anyway)
    if (typeof val === 'function' || typeof val === 'symbol' || val === undefined) return undefined;

    if (typeof val === 'bigint') return val.toString();     // JSON can’t handle BigInt
    if (val instanceof Date) return val.toISOString();      // normalize dates

    if (val && typeof val === 'object') {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
      return normalizeObject(val);
    }

    return val;
  };

  return JSON.stringify(value, replacer, pretty ? 2 : 0);
}
