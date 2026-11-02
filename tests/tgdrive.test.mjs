import assert from 'node:assert/strict';
import { test } from 'node:test';
import baseWorker from '../worker.js';
import themeWorker from '../zt/worker.js';
import { environment, fakeUpstream, request, SOURCE } from './helpers.mjs';

for (const [label, worker] of [['base', baseWorker], ['theme', themeWorker]]) {
  test(label + ': TG audio import, D1 metadata/poster persistence, fresh links and R2 preservation', async () => {
    const env = await environment();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeUpstream;
    const call = req => worker.fetch(req, env, { waitUntil() {} });
    try {
      assert.equal((await call(request('/api/tgdrive/catalog'))).status, 401);
      const catalog = await call(request('/api/tgdrive/catalog?page=2', 'GET', undefined, true));
      const entries = await catalog.json();
      assert.equal(entries.total, 37);
      assert.equal(entries.items.length, 7);
      assert.ok(entries.items.every(item => item.kind === 'audio' && !item.stream_url));
      const imported = await call(request('/api/tgdrive/import', 'POST', { album: 'Imported album', items: [{ source_id: SOURCE, message_id: 1, title: 'Custom song' }] }, true));
      assert.equal(imported.status, 200);
      const name = (await imported.json()).added[0].name;
      assert.match(name, /^tgdrive_/);
      const list = await (await call(request('/api/list'))).json();
      assert.equal(list.files.length, 2);
      assert.ok(list.files.some(file => file.name === 'original.mp3'));
      assert.equal(list.files.find(file => file.name === name).album, 'Imported album');
      const bad = await (await call(request('/api/tgdrive/import', 'POST', { items: [{ source_id: SOURCE, message_id: 99 }] }, true))).json();
      assert.equal(bad.failed.length, 1);
      assert.equal(env.MUSIC_DB.sql.prepare('SELECT COUNT(*) AS count FROM tg_tracks').get().count, 1);
      assert.equal((await call(request('/api/meta/' + name, 'PUT', { title: 'No permission' }))).status, 401);
      await call(request('/api/meta/' + name, 'PUT', { title: 'Edited song', album: 'Edited album', artist: 'Artist' }, true));
      const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
      assert.equal((await call(new Request('https://music.example.test/api/cover/' + name, { method: 'POST', headers: { Authorization: 'Bearer test-admin', 'Content-Type': 'image/png' }, body: png }))).status, 200);
      const image = await call(request('/api/cover/' + name));
      assert.equal(image.headers.get('Content-Type'), 'image/png');
      assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
      await call(request('/api/meta/' + name, 'PUT', { title: 'Title only', album: 'Final album', coverUrl: '' }, true));
      assert.ok(env.MUSIC_DB.sql.prepare('SELECT cover_data FROM tg_tracks WHERE name=?').get(name).cover_data);
      await call(request('/api/tgdrive/import', 'POST', { album: 'Overwrite attempt', items: [{ source_id: SOURCE, message_id: 1 }] }, true));
      assert.equal(env.MUSIC_DB.sql.prepare('SELECT album FROM tg_tracks WHERE name=?').get(name).album, 'Final album');
      const stream = await call(request('/api/file/' + name));
      assert.equal(stream.status, 302);
      assert.match(stream.headers.get('Location'), /\/v1\/music\/media\//);
      assert.ok(!stream.headers.get('Location').includes(env.TGDRIVE_TOKEN));
      assert.equal((await call(request('/api/file/' + name, 'HEAD'))).status, 302);
      await call(request('/api/lyrics?name=' + name, 'PUT', { lrc: '[00:00] Lyrics' }, true));
      assert.equal((await (await call(request('/api/lyrics?name=' + name))).json()).lrc, '[00:00] Lyrics');
      const batch = await (await call(request('/api/batch', 'POST', { action: 'meta', names: ['original.mp3', name], fields: { album: 'Together' } }, true))).json();
      assert.equal(batch.succeeded.length, 2);
      assert.equal(env.MUSIC_DB.sql.prepare('SELECT album FROM tg_tracks WHERE name=?').get(name).album, 'Together');
      assert.equal((await (await env.MUSIC_BUCKET.get('_meta.json')).json())['original.mp3'].album, 'Together');
      await call(request('/api/file/' + name, 'DELETE', undefined, true));
      assert.equal(env.MUSIC_DB.sql.prepare('SELECT COUNT(*) AS count FROM tg_tracks').get().count, 0);
      assert.equal(new TextDecoder().decode((await env.MUSIC_BUCKET.get('original.mp3')).body), 'original-audio');
      assert.equal((await (await env.MUSIC_BUCKET.get('_site.json')).json()).name, 'Existing site');
    } finally { globalThis.fetch = originalFetch; env.MUSIC_DB.close(); }
  });

  test(label + ': rejects video playback, unsafe poster URLs and oversized D1 posters', async () => {
    const env = await environment(), original = globalThis.fetch;
    const db = env.MUSIC_DB;
    globalThis.fetch = fakeUpstream;
    const call = req => worker.fetch(req, env, { waitUntil() {} });
    try {
      const data = await (await call(request('/api/tgdrive/import', 'POST', { items: [{ source_id: SOURCE, message_id: 1 }] }, true))).json();
      const name = data.added[0].name;
      assert.equal((await call(request('/api/meta/' + name, 'PUT', { coverUrl: 'javascript:alert(1)' }, true))).status, 400);
      assert.equal((await call(new Request('https://music.example.test/api/cover/' + name, { method: 'POST', headers: { Authorization: 'Bearer test-admin', 'Content-Type': 'image/png' }, body: new Uint8Array(512 * 1024 + 1) }))).status, 413);
      globalThis.fetch = async () => Response.json({ kind: 'video', mime: 'video/mp4', stream_url: 'https://tgdrive.example.test/video' });
      assert.equal((await call(request('/api/file/' + name))).status, 415);
      delete env.MUSIC_DB;
      assert.equal((await (await call(request('/api/list'))).json()).files.length, 1);
    } finally { globalThis.fetch = original; db.close(); }
  });
}
