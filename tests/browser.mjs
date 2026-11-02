import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, webkit } from 'playwright';
import { environment, fakeUpstream, wave, SOURCE } from './helpers.mjs';

const listen = async handler => {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
};
async function send(response, output) {
  output.writeHead(response.status, Object.fromEntries(response.headers));
  output.end(Buffer.from(await response.arrayBuffer()));
}
const useWebKit = process.argv.includes('--webkit');
const longPlayback = process.argv.includes('--long-playback');
const browser = await (useWebKit ? webkit : chromium).launch({ headless: true });
try {
  for (const variant of ['worker', 'zt-worker']) {
    const worker = (await import('../dist/' + variant + '.js')).default;
    const env = await environment();
    let mediaRequests = 0;
    const pcm = wave(longPlayback ? 90 : 20);
    const backend = await listen(async (req, res) => {
      try {
        const url = new URL(req.url, backend.origin);
        if (url.pathname.includes('/v1/music/media/')) {
          mediaRequests++;
          const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
          const start = match ? Number(match[1]) : 0;
          const end = match && match[2] ? Math.min(Number(match[2]), pcm.length - 1) : pcm.length - 1;
          const headers = { 'Content-Type': 'audio/wav', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
          if (match) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + pcm.length;
          res.writeHead(match ? 206 : 200, headers); res.end(pcm.subarray(start, end + 1)); return;
        }
        const response = await fakeUpstream(url.href, { headers: { Authorization: req.headers.authorization } });
        const data = await response.json();
        if (data.stream_url) {
          data.stream_url = backend.origin + new URL(data.stream_url).pathname + '?exp=1&sig=test';
          data.size = pcm.length; data.duration = longPlayback ? 90 : 20;
        }
        await send(Response.json(data, { status: response.status }), res);
      } catch { res.writeHead(500); res.end('fixture failure'); }
    });
    env.TGDRIVE_URL = backend.origin + '/tgdrive-api';
    const app = await listen(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const request = new Request(new URL(req.url, app.origin), { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
        await send(await worker.fetch(request, env, { waitUntil(promise) { promise.catch(() => {}); } }), res);
      } catch { res.writeHead(500); res.end('fixture failure'); }
    });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      sessionStorage.setItem('r2m_token', 'test-admin');
      const NativeAudio = window.Audio;
      window.__testAudio = [];
      window.Audio = function (...args) { const instance = new NativeAudio(...args); window.__testAudio.push(instance); return instance; };
      window.Audio.prototype = NativeAudio.prototype;
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(app.origin);
      await page.locator('#tgdriveImport').waitFor({ state: 'visible' });
      await page.locator('#tgdriveImport').click();
      await page.waitForFunction(() => document.querySelectorAll('#tgResults input[type=checkbox]').length === 30);
      await page.locator('#tgResults input[aria-label="自定义歌曲名"]').first().fill('自定义 TG 歌曲');
      await page.locator('#tgResults input[type=checkbox]').first().check();
      await page.locator('#tgAlbum').fill('我的TG专辑');
      await page.locator('#tgImport').click();
      await page.waitForFunction(() => document.querySelector('#tgStatus').textContent.includes('已导入 1 首'));
      const name = 'tgdrive_' + SOURCE + '_1.wav';
      await page.locator('#tgClose').click();
      await page.locator('.track[data-name="' + name + '"] .edit').click();
      await page.locator('#eTitle').fill('海报歌曲 <img src=x>');
      await page.locator('#eAlbum').fill('自定义专辑名');
      const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2; canvas.getContext('2d').fillRect(0, 0, 2, 2); return canvas.toDataURL('image/png').split(',')[1]; });
      await page.locator('#cvInput').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await page.waitForFunction(() => document.querySelector('#cvBox').style.backgroundImage.includes('blob:'));
      await page.locator('#btnEditOk').click();
      await page.locator('#editModal').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => [...document.querySelectorAll('.track .name')].some(node => node.textContent === '海报歌曲 <img src=x>'));
      const stored = env.MUSIC_DB.sql.prepare('SELECT * FROM tg_tracks WHERE name=?').get(name);
      assert.equal(stored.title, '海报歌曲 <img src=x>');
      assert.equal(stored.album, '自定义专辑名');
      assert.ok(stored.cover_data.length > 0);
      assert.equal(stored.cover_type, 'image/jpeg');
      assert.equal(await page.locator('.track .name img').count(), 0);
      await page.locator('.track[data-name="' + name + '"] .name').click();
      await page.waitForFunction(() => window.__testAudio.some(audio => !audio.paused && audio.currentTime > 0.1), null, { timeout: 15000 });
      assert.ok(mediaRequests > 0);
      if (longPlayback) {
        await page.waitForFunction(() => window.__testAudio[0].currentTime > 35, null, { timeout: 45000 });
        assert.ok(await page.evaluate(() => window.__testAudio[0].src.includes('tgdrive_')));
      }
      await page.evaluate(async () => {
        const audio = window.__testAudio[0];
        if (!audio.paused) await new Promise(resolve => { audio.addEventListener('pause', resolve, { once: true }); audio.pause(); });
        audio.dispatchEvent(new Event('ended'));
      });
      assert.ok(await page.evaluate(() => window.__testAudio[0].src.includes('tgdrive_')), 'Premature ended must not skip the current TG song');
      assert.match(await page.locator('#pSub').textContent(), /提前结束/);
      await page.locator('.track[data-name="' + name + '"] .name').click();
      await page.waitForFunction(() => !window.__testAudio[0].paused && window.__testAudio[0].readyState >= 2);
      await page.evaluate(() => { const audio = window.__testAudio[0]; audio.currentTime = audio.duration - 0.25; });
      await page.waitForFunction(() => window.__testAudio[0].src.includes('original.mp3'), null, { timeout: 10000 });
      assert.ok(env.MUSIC_BUCKET.objects.has('original.mp3'));
      assert.equal((await (await env.MUSIC_BUCKET.get('_site.json')).json()).name, 'Existing site');
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      console.log(variant + ': import/edit/playback, premature-end guard and normal next-track passed (' + (useWebKit ? 'WebKit' : 'Chromium') + (longPlayback ? ', sustained playback' : '') + ')');
    } finally {
      await context.close();
      app.server.closeAllConnections(); backend.server.closeAllConnections();
      await Promise.all([new Promise(resolve => app.server.close(resolve)), new Promise(resolve => backend.server.close(resolve))]);
      env.MUSIC_DB.close();
    }
  }
} finally { await browser.close(); }
