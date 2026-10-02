const SECRET_KEY = /(token|password|secret|credential|authorization)/i;
const MAX_AUDIT_DOCUMENT_BYTES = 10 * 1024 * 1024;

function sanitizeAuditValue(value, options = {}, depth = 0) {
  const {
    maxArrayItems = 30,
    maxStringLength = 2000,
    maxObjectKeys = 40,
    maxDepth = 7,
  } = options;

  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}[truncated]` : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[buffer:${value.length} bytes]`;
  if (typeof value?.toHexString === 'function') return value.toHexString();
  if (depth >= maxDepth) return '[max-depth]';

  if (Array.isArray(value)) {
    const items = value.slice(0, maxArrayItems).map((item) => sanitizeAuditValue(item, options, depth + 1));
    if (value.length > maxArrayItems) items.push(`[${value.length - maxArrayItems} items omitted]`);
    return items;
  }

  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, maxObjectKeys)) {
      result[key] = SECRET_KEY.test(key)
        ? '[redacted]'
        : sanitizeAuditValue(item, options, depth + 1);
    }
    if (Object.keys(value).length > maxObjectKeys) result._truncatedKeys = true;
    return result;
  }

  return String(value);
}

function createRecoverySnapshot(value) {
  const snapshot = sanitizeAuditValue(value, {
    maxArrayItems: 2000,
    maxStringLength: MAX_AUDIT_DOCUMENT_BYTES,
    maxObjectKeys: 500,
    maxDepth: 16,
  });
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_AUDIT_DOCUMENT_BYTES) return null;
  return snapshot;
}

module.exports = { sanitizeAuditValue, createRecoverySnapshot };