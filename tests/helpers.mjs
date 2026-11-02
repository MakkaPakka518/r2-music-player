import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export class TestD1 {
  constructor() {
    this.sql = new DatabaseSync(':memory:');
    this.sql.exec(readFileSync(new URL('../migrations/0001_tg_tracks.sql', import.meta.url), 'utf8'));
  }
  prepare(query) {
    const database = this.sql;
    let args = [];
    const statement = {
      bind(...values) { args = values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value); return statement; },
      async first() { return database.prepare(query).get(...args) || null; },
      async all() { return { results: database.prepare(query).all(...args), success: true }; },
      async run() { const result = database.prepare(query).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
    return statement;
  }
  close() { this.sql.close(); }
}

export class TestR2 {
  objects = new Map();
  async put(key, body, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, { bytes, type: options.httpMetadata?.contentType || 'application/octet-stream', uploaded: new Date('2026-01-01T00:00:00Z') });
    return this.head(key);
  }
  async head(key) {
    const row = this.objects.get(key);
    if (!row) return null;
    return { key, size: row.bytes.length, uploaded: row.uploaded, httpEtag: '"test-' + key + '"', writeHttpMetadata(headers) { headers.set('content-type', row.type); } };
  }
  async get(key, options = {}) {
    const head = await this.head(key);
    if (!head) return null;
    const row = this.objects.get(key);
    const bytes = options.range ? row.bytes.slice(options.range.offset, options.range.offset + options.range.length) : row.bytes;
    return { ...head, body: bytes, json: async () => JSON.parse(new TextDecoder().decode(bytes)) };
  }
  async delete(key) { this.objects.delete(key); }
  async list() { return { objects: await Promise.all([...this.objects.keys()].map(key => this.head(key))), truncated: false }; }
}

export const SOURCE = 'a'.repeat(24);
export function trackInfo(id = 1) {
  return {
    id, source_id: SOURCE, source_title: 'Audio source', kind: id === 99 ? 'video' : 'audio',
    mime: id === 99 ? 'video/mp4' : 'audio/wav', file_name: 'test-' + id + '.wav', title: 'Track ' + id,
    performer: 'Test artist', size: 320044, duration: 20, date: '2026-01-01T00:00:00Z', has_artwork: false,
    stream_url: 'https://tgdrive.example.test/tgdrive-api/v1/music/media/' + SOURCE + '/' + id + '?exp=1&sig=test',
  };
}
export function fakeUpstream(url, options = {}) {
  if (options.headers.Authorization !== 'Bearer test-audio-token') throw new Error('Service token was not forwarded correctly');
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/sources')) return Response.json({ sources: [{ id: SOURCE, title: 'Audio source', audio_count: 37 }] });
  if (parsed.pathname.endsWith('/catalog')) {
    const all = Array.from({ length: 37 }, (_, i) => trackInfo(i + 1)).filter(item => item.title.includes(parsed.searchParams.get('q') || ''));
    const page = Number(parsed.searchParams.get('page') || 1);
    return Response.json({ items: all.slice((page - 1) * 30, page * 30), total: all.length, page, pages: Math.max(1, Math.ceil(all.length / 30)), has_next: page * 30 < all.length, page_size: 30 });
  }
  const item = parsed.pathname.match(/\/item\/([a-f0-9]{24})\/(\d+)$/);
  if (item) return Response.json(trackInfo(Number(item[2])));
  return Response.json({ error: 'unexpected path' }, { status: 404 });
}
export async function environment() {
  const env = { AUTH_TOKEN: 'test-admin', MUSIC_BUCKET: new TestR2(), MUSIC_DB: new TestD1(), TGDRIVE_URL: 'https://tgdrive.example.test/tgdrive-api', TGDRIVE_TOKEN: 'test-audio-token' };
  await env.MUSIC_BUCKET.put('original.mp3', 'original-audio', { httpMetadata: { contentType: 'audio/mpeg' } });
  await env.MUSIC_BUCKET.put('_site.json', JSON.stringify({ name: 'Existing site', sub: 'Existing subtitle' }));
  return env;
}
export function request(path, method = 'GET', data, admin = false) {
  return new Request('https://music.example.test' + path, {
    method, headers: { ...(admin ? { Authorization: 'Bearer test-admin' } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
export function wave(seconds = 20) {
  const length = seconds * 16000;
  const data = Buffer.alloc(44 + length);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(length, 40);
  return data;
}
