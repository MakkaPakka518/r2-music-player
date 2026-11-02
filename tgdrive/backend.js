const COVER_LIMIT = 512 * 1024;
const AUDIO_EXTS = ['mp3', 'm4a', 'flac', 'ogg', 'oga', 'wav', 'aac', 'opus', 'weba'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const COLUMNS = 'name,source_id,message_id,original_name,mime,size,duration,uploaded,title,artist,album,cover_url,cover_type,cover_version,has_artwork,(cover_data IS NOT NULL) AS has_cover';

class TGError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function database(env) {
  if (!env.MUSIC_DB) throw new TGError(503, '请先绑定 MUSIC_DB 并执行数据库迁移');
  return env.MUSIC_DB;
}
function ref(source, id) {
  if (typeof source !== 'string' || !/^[a-f0-9]{24}$/.test(source) || !Number.isSafeInteger(id) || id < 1) throw new TGError(400, '无效的音频来源');
  return source + '/' + id;
}
function audio(info) {
  if (!info || info.kind !== 'audio' || typeof info.mime !== 'string' || !info.mime.toLowerCase().startsWith('audio/')) throw new TGError(415, '这里只能导入和播放音频文件');
  return info;
}
function text(value, maximum = 200) {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new TGError(400, '请输入有效文本（最多' + maximum + '字）');
  return value.trim();
}
function imageUrl(value) {
  const result = text(value, 2048);
  if (!result) return '';
  let parsed;
  try { parsed = new URL(result); } catch { throw new TGError(400, '海报链接必须是HTTPS地址'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new TGError(400, '海报链接必须是HTTPS地址');
  return parsed.href;
}
export function isTGName(name) { return typeof name === 'string' && /^tgdrive_[a-f0-9]{24}_[1-9][0-9]*\.[a-z0-9]+$/.test(name); }
function trackName(info) {
  ref(info.source_id, info.id);
  let extension = String(info.file_name || '').split('.').pop().toLowerCase();
  if (!AUDIO_EXTS.includes(extension)) extension = ({ 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/webm': 'weba' })[info.mime.toLowerCase()] || 'wav';
  return 'tgdrive_' + info.source_id + '_' + info.id + '.' + extension;
}
function view(row) {
  return {
    source: 'tgdrive', name: row.name, size: row.size, uploaded: row.uploaded,
    title: row.title || row.original_name, artist: row.artist, album: row.album, duration: row.duration,
    originalName: row.original_name, posterUrl: row.cover_url,
    cover: row.has_cover || row.cover_url || row.has_artwork ? '/api/cover/' + encodeURIComponent(row.name) + '?v=' + row.cover_version : '',
  };
}
async function track(env, name, includeImage = false) {
  if (!env.MUSIC_DB || !isTGName(name)) return null;
  return env.MUSIC_DB.prepare('SELECT ' + (includeImage ? '*' : COLUMNS) + ' FROM tg_tracks WHERE name=?').bind(name).first();
}
export async function listTGTracks(env) {
  if (!env.MUSIC_DB) return [];
  const result = [];
  let cursor = '';
  while (true) {
    const rows = (await env.MUSIC_DB.prepare('SELECT ' + COLUMNS + ' FROM tg_tracks WHERE name>? ORDER BY name LIMIT 500').bind(cursor).all()).results;
    result.push(...rows.map(view));
    if (rows.length < 500) return result;
    cursor = rows[rows.length - 1].name;
  }
}
async function upstream(env, path) {
  if (!env.TGDRIVE_URL || !env.TGDRIVE_TOKEN) throw new TGError(503, '请先配置 TGDRIVE_URL 和音频专用 TGDRIVE_TOKEN');
  let response;
  try {
    response = await fetch(env.TGDRIVE_URL.replace(/\/+$/, '') + '/v1/music/' + path, {
      headers: { Authorization: 'Bearer ' + env.TGDRIVE_TOKEN }, redirect: 'manual', signal: AbortSignal.timeout(45000),
    });
  } catch { throw new TGError(502, 'TGDrive后端暂时无法连接'); }
  if (!response.ok) {
    if (response.status === 415) throw new TGError(415, '这里只能导入和播放音频文件');
    if (response.status === 404) throw new TGError(404, '音频已不存在或来源已被移除');
    if (response.status === 401) throw new TGError(502, 'TGDrive音频专用令牌配置不正确');
    throw new TGError(response.status === 429 ? 429 : 502, 'TGDrive暂时无法完成请求，请稍后重试');
  }
  try { return await response.json(); } catch { throw new TGError(502, 'TGDrive返回了无效响应'); }
}
function trustedURL(env, value, kind) {
  let target, base;
  try { target = new URL(value); base = new URL(env.TGDRIVE_URL); } catch { throw new TGError(502, 'TGDrive返回了无效链接'); }
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname.replace(/\/+$/, '') + '/v1/music/' + kind + '/')) throw new TGError(502, 'TGDrive返回了无效链接');
  return target.href;
}
async function bodyJSON(request, limit, readLimitedBody) {
  const bytes = await readLimitedBody(request.body, limit);
  if (!bytes) throw new TGError(413, '请求内容过大');
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new TGError(400, '请求格式错误'); }
}
async function importTrack(env, input, defaults) {
  ref(input.source_id, input.message_id);
  const info = audio(await upstream(env, 'item/' + ref(input.source_id, input.message_id)));
  if (info.source_id !== input.source_id || info.id !== input.message_id) throw new TGError(502, '音频来源不匹配');
  const title = text(input.title === undefined ? String(info.title || info.file_name).slice(0, 200) : input.title);
  const artist = text(input.artist === undefined ? String(info.performer || '').slice(0, 200) : input.artist);
  const album = text(input.album === undefined ? defaults.album || '' : input.album);
  const coverUrl = imageUrl(input.coverUrl === undefined ? defaults.coverUrl || '' : input.coverUrl);
  const name = trackName(info);
  if (await env.MUSIC_BUCKET.head(name)) throw new TGError(409, '该名称与已有R2文件冲突');
  const now = Date.now();
  const saved = await database(env).prepare(`INSERT INTO tg_tracks
    (name,source_id,message_id,original_name,mime,size,duration,uploaded,title,artist,album,cover_url,has_artwork,created_at,updated_at,cover_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,message_id) DO NOTHING`).bind(
    name, input.source_id, input.message_id, String(info.file_name || name), info.mime, Number(info.size) || 0,
    Number(info.duration) || 0, String(info.date || new Date().toISOString()), title, artist, album, coverUrl,
    info.has_artwork ? 1 : 0, now, now, now,
  ).run();
  const row = await database(env).prepare('SELECT ' + COLUMNS + ' FROM tg_tracks WHERE source_id=? AND message_id=?').bind(input.source_id, input.message_id).first();
  return { ...view(row), created: saved.meta?.changes > 0 };
}
async function metadata(env, row, data, automatic = false) {
  const values = {};
  for (const key of ['title', 'artist', 'album']) if (Object.hasOwn(data, key)) values[key] = text(data[key]);
  if (Object.hasOwn(data, 'coverUrl')) values.coverUrl = imageUrl(data.coverUrl);
  const fields = [], parameters = [];
  for (const key of ['title', 'artist', 'album']) {
    if (Object.hasOwn(values, key) && (!automatic || !row[key])) { fields.push(key + '=?'); parameters.push(values[key]); }
  }
  if (!automatic && Object.hasOwn(values, 'coverUrl') && values.coverUrl !== row.cover_url) {
    fields.push('cover_url=?', 'cover_version=MAX(cover_version+1,?)'); parameters.push(values.coverUrl, Date.now());
    if (values.coverUrl) fields.push("cover_data=NULL", "cover_type=''");
  }
  if (fields.length) await database(env).prepare('UPDATE tg_tracks SET ' + fields.join(',') + ',updated_at=? WHERE name=?').bind(...parameters, Date.now(), row.name).run();
  return { ok: true, changed: fields.length > 0, hasCover: !!(row.has_cover || row.cover_url || row.has_artwork) };
}
async function deleteTrack(env, name) {
  await database(env).prepare('DELETE FROM tg_tracks WHERE name=?').bind(name).run();
}
function validImage(bytes, type) {
  const ascii = (a, b) => String.fromCharCode(...bytes.slice(a, b));
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n);
  if (type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  return type === 'image/webp' && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
}

export async function routeTGDrive(request, env, url, helpers) {
  const path = url.pathname, method = request.method;
  const control = path.startsWith('/api/tgdrive/');
  const audioPath = /^\/api\/(file|cover|meta|meta-auto)\/(.+)$/.exec(path);
  let name;
  try { name = audioPath ? decodeURIComponent(audioPath[2]) : url.searchParams.get('name'); } catch { return json({ error: '文件名编码无效' }, 400); }
  if (!control && !isTGName(name) && path !== '/api/batch' && path !== '/api/upload') return null;
  try {
    if (control) {
      if (!env.AUTH_TOKEN || !helpers.authorized(request, env)) throw new TGError(401, '需要管理令牌');
      if (path === '/api/tgdrive/status' && method === 'GET') return json({ enabled: !!(env.MUSIC_DB && env.TGDRIVE_URL && env.TGDRIVE_TOKEN), audioOnly: true });
      database(env);
      if (path === '/api/tgdrive/sources' && method === 'GET') return json(await upstream(env, 'sources'));
      if (path === '/api/tgdrive/catalog' && method === 'GET') {
        const page = Number(url.searchParams.get('page') || 1), source = url.searchParams.get('source_id') || '';
        if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || (source && !/^[a-f0-9]{24}$/.test(source))) throw new TGError(400, '页码或来源无效');
        const data = await upstream(env, 'catalog?' + new URLSearchParams({ page: String(page), source_id: source, q: (url.searchParams.get('q') || '').slice(0, 200) }));
        if (!Array.isArray(data.items) || data.items.some(item => item.kind !== 'audio' || !String(item.mime).toLowerCase().startsWith('audio/'))) throw new TGError(502, '后端没有返回纯音频列表，请更新TGDrive');
        const keys = data.items.map(item => item.source_id + ':' + item.id);
        const present = keys.length ? (await database(env).prepare("SELECT source_id,message_id FROM tg_tracks WHERE (source_id || ':' || message_id) IN (" + keys.map(() => '?').join(',') + ')').bind(...keys).all()).results : [];
        const imported = new Set(present.map(item => item.source_id + ':' + item.message_id));
        for (const item of data.items) {
          item.imported = imported.has(item.source_id + ':' + item.id);
          delete item.stream_url; delete item.thumb_url; delete item.account_id;
        }
        return json(data);
      }
      if (path === '/api/tgdrive/import' && method === 'POST') {
        const data = await bodyJSON(request, 65536, helpers.readLimitedBody);
        if (!Array.isArray(data.items) || !data.items.length || data.items.length > 10) throw new TGError(400, '单次请求可导入1至10首音频，网页会自动分批');
        const defaults = { album: text(data.album || ''), coverUrl: imageUrl(data.coverUrl || '') };
        const added = [], failed = [];
        for (const item of data.items) {
          try { added.push(await importTrack(env, item, defaults)); }
          catch (error) { failed.push({ source_id: item?.source_id, message_id: item?.message_id, error: error instanceof TGError ? error.message : '保存歌曲失败' }); }
        }
        return json({ ok: !failed.length, added, failed }, failed.length ? 207 : 200);
      }
      throw new TGError(404, '接口不存在');
    }
    if (path === '/api/upload') {
      if (isTGName(url.searchParams.get('name'))) throw new TGError(400, '该文件名前缀用于TGDrive歌曲');
      return null;
    }
    if (!env.MUSIC_DB) return null;
    if (path === '/api/batch') {
      if (method !== 'POST') return null;
      const data = await bodyJSON(request.clone(), 65536, helpers.readLimitedBody);
      if (!Array.isArray(data.names) || data.names.length > 200 || !['meta', 'delete'].includes(data.action)) return null;
      const rows = new Map();
      const candidates = [...new Set(data.names.filter(isTGName))];
      for (let offset = 0; offset < candidates.length; offset += 80) {
        const names = candidates.slice(offset, offset + 80);
        const result = await database(env).prepare('SELECT ' + COLUMNS + ' FROM tg_tracks WHERE name IN (' + names.map(() => '?').join(',') + ')').bind(...names).all();
        result.results.forEach(row => rows.set(row.name, row));
      }
      if (!rows.size) return null;
      if (!env.AUTH_TOKEN || !helpers.authorized(request, env)) throw new TGError(401, '需要管理令牌');
      if (data.action === 'meta' && (!data.fields || !Object.keys(data.fields).length || Object.keys(data.fields).some(key => !['artist', 'album'].includes(key) || typeof data.fields[key] !== 'string' || data.fields[key].length > 200))) throw new TGError(400, '专辑/艺术家格式无效');
      let result = { succeeded: [], failed: [], deletedAudio: [] };
      const legacy = data.names.filter(key => !rows.has(key));
      if (legacy.length) {
        const legacyRequest = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify({ ...data, names: legacy }) });
        const response = await helpers.legacyBatch(legacyRequest, env, url);
        result = await response.json();
        if (!Array.isArray(result.succeeded)) return json(result, response.status);
      }
      const names = [...rows.keys()];
      for (let offset = 0; offset < names.length; offset += 80) {
        const group = names.slice(offset, offset + 80), where = group.map(() => '?').join(',');
        try {
          if (data.action === 'delete') await database(env).prepare('DELETE FROM tg_tracks WHERE name IN (' + where + ')').bind(...group).run();
          else {
            const fields = Object.keys(data.fields);
            await database(env).prepare('UPDATE tg_tracks SET ' + fields.map(key => key + '=?').join(',') + ',updated_at=? WHERE name IN (' + where + ')').bind(...fields.map(key => text(data.fields[key])), Date.now(), ...group).run();
          }
          result.succeeded.push(...group);
        } catch { group.forEach(name => result.failed.push({ name, error: 'D1操作失败' })); }
      }
      return json({ ...result, ok: !result.failed.length, count: result.succeeded.length, atomic: false }, result.failed.length ? 207 : 200);
    }
    const row = await track(env, name, audioPath?.[1] === 'cover' && method === 'GET');
    if (!row) return null;
    if (!['GET', 'HEAD'].includes(method) && (!env.AUTH_TOKEN || !helpers.authorized(request, env))) throw new TGError(401, '需要管理令牌');
    if (audioPath?.[1] === 'file') {
      if (method === 'DELETE') { await deleteTrack(env, name); return json({ ok: true }); }
      if (!['GET', 'HEAD'].includes(method)) throw new TGError(405, '不支持的请求方法');
      const info = audio(await upstream(env, 'item/' + ref(row.source_id, row.message_id)));
      return new Response(null, { status: 302, headers: { Location: trustedURL(env, info.stream_url, 'media'), 'Cache-Control': 'private, no-store' } });
    }
    if (audioPath?.[1] === 'meta' && method === 'PUT') return json(await metadata(env, row, await bodyJSON(request, 8192, helpers.readLimitedBody)));
    if (audioPath?.[1] === 'meta-auto' && method === 'POST') return json(await metadata(env, row, await bodyJSON(request, 4096, helpers.readLimitedBody), true));
    if (audioPath?.[1] === 'cover') {
      if (method === 'GET') {
        if (row.cover_data !== null) return new Response(new Uint8Array(row.cover_data), { headers: { 'Content-Type': row.cover_type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' } });
        if (row.cover_url) return Response.redirect(imageUrl(row.cover_url), 302);
        if (row.has_artwork) {
          const info = audio(await upstream(env, 'item/' + ref(row.source_id, row.message_id)));
          if (info.thumb_url) return new Response(null, { status: 302, headers: { Location: trustedURL(env, info.thumb_url, 'thumb'), 'Cache-Control': 'private, no-store' } });
        }
        throw new TGError(404, '尚未设置海报');
      }
      if (method === 'DELETE') {
        await database(env).prepare("UPDATE tg_tracks SET cover_data=NULL,cover_type='',cover_url='',has_artwork=0,cover_version=MAX(cover_version+1,?) WHERE name=?").bind(Date.now(), name).run();
        return json({ ok: true });
      }
      if (method === 'POST') {
        if (url.searchParams.get('auto') === '1' && (row.has_cover || row.cover_url || row.has_artwork)) return json({ ok: true, skipped: true, hasCover: true });
        const type = (request.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
        if (!IMAGE_TYPES.includes(type)) throw new TGError(415, '海报仅支持jpg/png/webp/gif');
        const bytes = await helpers.readLimitedBody(request.body, COVER_LIMIT);
        if (!bytes) throw new TGError(413, 'D1海报上限为512KiB，请缩小图片');
        if (!validImage(bytes, type)) throw new TGError(400, '图片内容与类型不符');
        await database(env).prepare("UPDATE tg_tracks SET cover_data=?,cover_type=?,cover_url='',cover_version=MAX(cover_version+1,?),updated_at=? WHERE name=?").bind(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), type, Date.now(), Date.now(), name).run();
        return json({ ok: true, hasCover: true });
      }
    }
    if (path === '/api/lyrics') {
      if (method === 'GET') return json({ lrc: (await database(env).prepare('SELECT lrc FROM tg_tracks WHERE name=?').bind(name).first())?.lrc || '' });
      if (method === 'DELETE') { await database(env).prepare("UPDATE tg_tracks SET lrc='' WHERE name=?").bind(name).run(); return json({ lrc: '' }); }
      if (method === 'PUT') {
        const bytes = await helpers.readLimitedBody(request.body, 256 * 1024);
        if (!bytes) throw new TGError(413, '歌词超过256KiB');
        let lrc = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if ((request.headers.get('Content-Type') || '').includes('application/json')) lrc = JSON.parse(lrc).lrc;
        if (typeof lrc !== 'string') throw new TGError(400, '歌词格式无效');
        await database(env).prepare('UPDATE tg_tracks SET lrc=? WHERE name=?').bind(lrc, name).run();
        return json({ lrc });
      }
    }
    throw new TGError(405, '不支持的请求方法');
  } catch (error) {
    return json({ error: error instanceof TGError ? error.message : 'TG歌曲数据库操作失败，请检查D1绑定及迁移' }, error instanceof TGError ? error.status : 500);
  }
}
