export async function sleep({ seconds }, ctx) {
  const s = Number(seconds);
  if (!(s >= 0 && s <= 120)) throw new Error('seconds must be between 0 and 120');
  ctx?.log?.(`Waiting ${s}s`);
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, s * 1000);
    ctx?.signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
  return { value: s, evidence: { waitedSeconds: s }, io: { kind: 'command', request: { text: `wait ${s}s`, cwd: '' }, response: { exitCode: 0, summary: { waitedSeconds: s } } } };
}
