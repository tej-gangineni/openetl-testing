// Small fetch wrapper for the allowlisted local HTTP services.
export const HOSTS = {
  clickhouse: 'http://127.0.0.1:8123',
  elasticsearch: 'http://127.0.0.1:9200',
  relata: 'http://localhost:9090',
  openetl: 'http://127.0.0.1:8080',
  qdrant: 'http://127.0.0.1:6333',
  labweb: 'http://127.0.0.1:8765',
};

export async function request(method, url, { headers = {}, body, signal, timeoutMs = 60000 } = {}) {
  const allowed = Object.values(HOSTS).some((h) => url.startsWith(h + '/') || url === h);
  if (!allowed) throw new Error(`Host not allowed: ${url}`);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  signal?.addEventListener?.('abort', () => ac.abort(), { once: true });
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    throw new Error(`HTTP ${method} ${url} failed: ${e.cause?.code ?? e.message}`);
  } finally {
    clearTimeout(t);
  }
}
