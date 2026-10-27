// Helpers that build and cap the `io` object (contract v2): max 20 rows, 200 chars per cell, 8 KB total.
export const MAX_ROWS = 20;
export const MAX_CELL = 200;
export const MAX_IO_BYTES = 8000;

export function cell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + '...' : s;
}

// Tabular response { columns, rows, rowCount, truncated } from arrays of arrays.
export function table(columns, rows) {
  const out = rows.slice(0, MAX_ROWS).map((r) => r.map(cell));
  return { columns, rows: out, rowCount: rows.length, truncated: rows.length > MAX_ROWS };
}

export function cut(s, n = 4096) {
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  return t.length > n ? t.slice(0, n) + '...[cut]' : t;
}

// Keep the whole io object under MAX_IO_BYTES by dropping rows, then shortening cells.
export function capIo(io) {
  const size = () => JSON.stringify(io).length;
  const r = io?.response;
  if (r && Array.isArray(r.rows)) {
    while (size() > MAX_IO_BYTES && r.rows.length > 1) { r.rows.pop(); r.truncated = true; }
    if (size() > MAX_IO_BYTES) r.rows = r.rows.map((row) => row.map((c) => (typeof c === 'string' ? c.slice(0, 40) : c)));
  }
  if (size() > MAX_IO_BYTES && r && typeof r.body === 'string') r.body = r.body.slice(0, 2000) + '...[cut]';
  return io;
}

export function mask(text, secret) {
  if (!secret || typeof text !== 'string') return text;
  return text.split(secret).join('***');
}
