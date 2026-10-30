/**
 * R2 Music Player — 配合 Cloudflare R2 的在线小型播放器
 * 单文件 Worker:粘贴到 Cloudflare Dashboard 即可部署
 *
 * 版本:1.0.0
 * 绑定:R2 bucket 命名为 MUSIC_BUCKET(在 Worker 设置 → 绑定 → R2 中添加)
 * 可选环境变量:AUTH_TOKEN(配置后上传/删除需要令牌;留空则公开可传)
 *
 * 功能:
 *  - 文件列表(自动识别音频)
 *  - 在线播放(支持 Range 拖动进度条)
 *  - 上传 mp3/m4a/flac/ogg/wav/aac(可选令牌保护)
 *  - 删除文件(可选令牌保护)
 *  - 本地持久化播放列表(IndexedDB),播放进度自动记忆
 */

const VERSION = '1.4.0';

const AUDIO_EXTS = ['mp3', 'm4a', 'flac', 'ogg', 'oga', 'wav', 'aac', 'opus', 'weba'];
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB

function isAudio(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return AUDIO_EXTS.includes(name.slice(dot + 1).toLowerCase());
}

function contentTypeFor(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  const map = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac',
    ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav',
    aac: 'audio/aac', opus: 'audio/ogg', weba: 'audio/webm',
  };
  return map[ext] || 'application/octet-stream';
}

function safeKey(name) {
  // 仅保留安全文件名字符,拒绝路径穿越
  // 注意:调用方已经解码过一次,这里不能再 decode(否则含 % 的文件名会出错)
  let n = String(name).replace(/[\\\/\0]/g, '').trim();
  if (!n) return null;
  return n;
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(request, env) {
  const token = env.AUTH_TOKEN;
  if (!token) return true;
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? constantTimeEqual(m[1], token) : false;
}

// ---------- 自定义元数据(歌名/作者/专辑/封面) ----------
// 元数据索引:单个 JSON 对象 { "<文件名>": { title, artist, album, cv } },cv 为封面版本号(时间戳)
// 封面:存为 _covers/<文件名>.img(后缀 .img 不是音频扩展名,不会混进歌曲列表)
const INDEX_KEY = '_meta.json';
const COVER_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function coverKey(name) { return '_covers/' + name + '.img'; }

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function nameFrom(path, prefix) {
  const raw = path.slice(prefix.length);
  try { return safeKey(decodeURIComponent(raw)); } catch (e) { return safeKey(raw); }
}

async function readIndex(bucket) {
  const o = await bucket.get(INDEX_KEY);
  if (!o) return {};
  try { const j = await o.json(); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; }
}

async function writeIndex(bucket, idx) {
  await bucket.put(INDEX_KEY, JSON.stringify(idx), { httpMetadata: { contentType: 'application/json' } });
}

// ---------- 站点设置(名称 / 副标题 / Logo / 播放页背景) ----------
// _site.json: { name, sub, logo, background }  图片版本号为时间戳,0/缺省表示用默认样式
// Logo 图片存为 _site/logo.img;同时用作网页图标(favicon / apple-touch-icon)
// 播放页背景存为 _site/player-background.img,不使用音频扩展名
const SITE_KEY = '_site.json';
const LOGO_KEY = '_site/logo.img';
const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const BACKGROUND_KEY = '_site/player-background.img';
const BACKGROUND_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const DEFAULT_NAME = 'R2 Music';
const DEFAULT_SUB = 'v' + VERSION + ' · R2 播放器';
const NOTE_PATHS = '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>';
const DEFAULT_LOGO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + NOTE_PATHS + '</svg>';
const DEFAULT_FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#3f6fe0"/></linearGradient></defs>' +
  '<rect width="64" height="64" rx="16" fill="url(#g)"/>' +
  '<g transform="translate(16 16) scale(1.333)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + NOTE_PATHS + '</g></svg>';

async function readSite(bucket) {
  const o = await bucket.get(SITE_KEY);
  if (!o) return {};
  try { const j = await o.json(); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; }
}
async function writeSite(bucket, site) {
  await bucket.put(SITE_KEY, JSON.stringify(site), { httpMetadata: { contentType: 'application/json' } });
}
function siteView(site) {
  const logo = Number(site.logo) || 0;
  const background = Number(site.background) || 0;
  return {
    name: site.name || '', sub: site.sub || '', logo,
    logoUrl: logo ? '/api/site/logo?v=' + logo : '',
    background,
    backgroundUrl: background ? '/api/site/background?v=' + background : '',
    defaultName: DEFAULT_NAME, defaultSub: DEFAULT_SUB,
  };
}
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 服务端直接把名称 / Logo / 图标写进 HTML,首屏就是对的,不会闪一下默认值
function renderPage(site) {
  const v = siteView(site);
  const name = v.name || DEFAULT_NAME;
  const sub = v.sub || DEFAULT_SUB;
  const icons = v.logoUrl
    ? '<link rel="icon" type="image/png" href="' + v.logoUrl + '"><link rel="apple-touch-icon" href="' + v.logoUrl + '">'
    : '<link rel="icon" type="image/svg+xml" href="/favicon.svg">';
  const logo = v.logoUrl
    ? '<div class="logo custom" id="siteLogo"><img alt="" src="' + v.logoUrl + '"></div>'
    : '<div class="logo" id="siteLogo">' + DEFAULT_LOGO_SVG + '</div>';
  return HTML
    .replace('%%TITLE%%', () => escHtml(name) + ' · 在线播放器')
    .replace('%%ICONS%%', () => icons)
    .replace('%%LOGO%%', () => logo)
    .replace('%%NAME%%', () => escHtml(name))
    .replace('%%SUB%%', () => escHtml(sub))
    .replace('%%PLAYER_BG%%', () => escHtml(v.backgroundUrl));
}
async function serveLogo(bucket, headers) {
  const obj = await bucket.get(LOGO_KEY);
  if (!obj) return null;
  const h = new Headers(headers || {});
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  if (!h.has('content-type')) h.set('content-type', 'image/png');
  return new Response(obj.body, { status: 200, headers: h });
}

// 限量读取背景上传:不信任 Content-Length,超过上限立即取消流,不向 R2 写入部分数据
async function readLimitedBody(body, maxBytes) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// 自定义顺序:单个 JSON 数组 ["a.mp3","b.mp3",...];不在数组里的歌排在最后
const ORDER_KEY = '_order.json';

async function readOrder(bucket) {
  const o = await bucket.get(ORDER_KEY);
  if (!o) return [];
  try { const j = await o.json(); return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : []; } catch (e) { return []; }
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#08090d">
<meta name="color-scheme" content="dark light">
<title>%%TITLE%%</title>
%%ICONS%%
<script>
// 在渲染前就确定主题,避免浅色用户看到深色闪一下:有手动选择用手动选择,否则跟随系统
(function(){var t=null;try{t=localStorage.getItem('r2m_theme')}catch(e){}
if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark'}
document.documentElement.setAttribute('data-theme',t);
var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',t==='light'?'#f3f4f7':'#08090d')})();
</script>
<style>
:root{
  --bg:#08090d; --panel:#11131a; --panel2:#181b24; --elev:#1e222d;
  --hair:rgba(255,255,255,.07); --hair2:rgba(255,255,255,.12);
  --txt:#f3f5f9; --sub:#9aa0b0; --dim:#636a7c;
  --acc:#5b8cff; --acc-deep:#3f6fe0; --acc-soft:rgba(91,140,255,.13);
  --ok:#34d399; --err:#fb7185; --warn:#fbbf24;
  --r-lg:18px; --r:14px; --r-sm:10px;
  --sh:0 1px 2px rgba(0,0,0,.35),0 6px 20px rgba(0,0,0,.22);
  --bar-h:72px;
  color-scheme:dark;
}
html[data-theme="light"]{
  color-scheme:light;
  --bg:#f3f4f7; --panel:#ffffff; --panel2:#f4f5f8; --elev:#ffffff;
  --hair:rgba(16,22,40,.08); --hair2:rgba(16,22,40,.14);
  --txt:#14171f; --sub:#5a6070; --dim:#8b90a0;
  --acc:#4263eb; --acc-deep:#3651c9; --acc-soft:rgba(66,99,235,.1);
  --ok:#0ca678; --err:#e03131; --warn:#d9820b;
  --sh:0 1px 2px rgba(16,22,40,.06),0 8px 24px rgba(16,22,40,.08);
}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{
  background:var(--bg); color:var(--txt);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",sans-serif;
  min-height:100vh; padding-bottom:28px;
}
body.has-player{padding-bottom:calc(var(--bar-h) + 28px)}
body.now-open{position:fixed;left:0;right:0;overflow:hidden}
body::before{
  content:""; position:fixed; inset:0 0 auto; height:380px; pointer-events:none;
  background:radial-gradient(1100px 380px at 50% -12%, var(--acc-soft), transparent 70%);
}
.wrap{max-width:640px;margin:0 auto;padding:22px 18px 0;position:relative}
/* header */
header{display:flex;align-items:center;gap:12px;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:11px;flex:1;min-width:0}
.brand .logo{
  width:42px;height:42px;border-radius:14px;flex-shrink:0;
  background:linear-gradient(180deg,var(--acc),var(--acc-deep));
  display:flex;align-items:center;justify-content:center;color:#fff;
  box-shadow:0 4px 16px var(--acc-soft)
}
.brand .logo svg{width:22px;height:22px}
.brand h1{font-size:17px;font-weight:700;letter-spacing:.2px}
.brand .ver{font-size:10.5px;color:var(--dim);margin-top:1px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.hbtn{
  border:1px solid var(--hair2);background:var(--panel);color:var(--sub);
  width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;
  cursor:pointer;transition:.15s
}
.hbtn:hover{border-color:var(--acc);color:var(--acc)}
.hbtn svg{width:19px;height:19px}
/* search */
.search{
  display:flex;align-items:center;gap:8px;background:var(--panel);
  border:1px solid var(--hair);border-radius:var(--r);padding:0 13px;height:44px;
  margin-bottom:14px;transition:border-color .15s
}
.search:focus-within{border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-soft)}
.search svg{width:17px;height:17px;color:var(--dim);flex-shrink:0}
.search input{flex:1;background:none;border:0;outline:0;color:var(--txt);font-size:14px}
.search input::placeholder{color:var(--dim)}
.search .clear{color:var(--dim);cursor:pointer;font-size:16px;padding:2px 4px;display:none}
.search .clear.show{display:block}
/* upload strip */
.upload-strip{
  border:1px dashed var(--hair2);border-radius:var(--r);padding:12px 14px;
  display:flex;align-items:center;gap:12px;margin-bottom:14px;cursor:pointer;
  background:var(--panel);transition:.15s;display:none
}
.upload-strip.show{display:flex}
.upload-strip:hover,.upload-strip.drag{border-color:var(--acc);background:var(--acc-soft)}
.upload-strip svg{width:20px;height:20px;color:var(--acc);flex-shrink:0}
.upload-strip .u-txt{flex:1;font-size:13px;color:var(--sub)}
.upload-strip .u-txt b{color:var(--txt);font-weight:600}
.upload-strip .u-progress{width:100%;display:none;height:6px;border-radius:3px;background:var(--panel2);overflow:hidden}
.upload-strip .u-progress i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--acc),var(--acc-deep));border-radius:3px;transition:width .2s}
/* list */
.list{display:flex;flex-direction:column;gap:8px}
.track{
  display:flex;align-items:center;gap:12px;padding:11px 13px;
  background:var(--panel);border:1px solid var(--hair);border-radius:var(--r);
  cursor:pointer;transition:.15s;position:relative;overflow:hidden
}
.track:hover{border-color:var(--hair2);transform:translateY(-1px)}
.track.playing{border-color:var(--acc);background:var(--acc-soft)}
.track .idx{
  width:30px;height:30px;border-radius:9px;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;
  background:var(--panel2);color:var(--dim);font-size:12px;font-weight:600;
  font-family:ui-monospace,Menlo,monospace
}
.track.playing .idx{background:linear-gradient(180deg,var(--acc),var(--acc-deep));color:#fff}
.track .ic{width:30px;height:30px;border-radius:9px;flex-shrink:0;display:none;align-items:center;justify-content:center}
.track.playing .idx{display:none}
.track.playing .ic{display:flex}
.track .ic svg{width:16px;height:16px;color:#fff}
.track .meta{flex:1;min-width:0}
.track .name{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.track .info{font-size:11px;color:var(--dim);margin-top:2px;font-family:ui-monospace,Menlo,monospace}
.track .del,.track .edit{
  width:32px;height:32px;border-radius:9px;border:0;background:none;color:var(--dim);
  cursor:pointer;display:none;align-items:center;justify-content:center;flex-shrink:0
}
body.admin .track .del,body.admin .track .edit{display:flex}
.track .edit:hover{color:var(--acc);background:var(--acc-soft)}
.track .del:hover{color:var(--err);background:rgba(251,113,133,.1)}
.track .del svg,.track .edit svg{width:16px;height:16px}
.track .cv{width:36px;height:36px;border-radius:9px;flex-shrink:0;background:var(--panel2) center/cover no-repeat}
.track.hascv .idx,.track.hascv .ic{display:none!important}
.player .art.hascv svg{display:none}
.modal .sheet{max-height:92vh;overflow:auto}
.modal .lbl{font-size:11.5px;color:var(--dim);margin:12px 0 5px}
.cvrow{display:flex;align-items:center;gap:14px;margin-bottom:4px}
.cvbox{
  width:84px;height:84px;border-radius:14px;flex-shrink:0;cursor:pointer;
  background:var(--panel2) center/cover no-repeat;border:1px dashed var(--hair2);
  display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:11px;text-align:center
}
.cvbox.has{border-style:solid;color:transparent}
.cvbtns{display:flex;flex-direction:column;gap:8px}
.cvbtns button{height:36px;padding:0 14px;border-radius:10px;border:0;background:var(--panel2);color:var(--sub);font-size:12.5px;cursor:pointer}
.cvbtns button:hover{color:var(--txt)}
.track .playing-bar{position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,var(--acc),var(--acc-deep))}
/* empty */
.empty{
  text-align:center;padding:52px 20px;color:var(--dim)
}
.empty svg{width:44px;height:44px;opacity:.5;margin-bottom:12px}
.empty .t1{font-size:14px;color:var(--sub);font-weight:600}
.empty .t2{font-size:12px;margin-top:6px}
/* player bar */
.player{
  position:fixed;left:0;right:0;bottom:0;z-index:50;
  background:color-mix(in srgb,var(--panel) 82%,transparent);
  backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
  border-top:1px solid var(--hair);
  padding:10px 16px calc(10px + env(safe-area-inset-bottom));
  box-shadow:var(--sh)
}
.player .prog{display:flex;align-items:center;gap:10px}
.player .time{font-size:10.5px;color:var(--dim);font-family:ui-monospace,Menlo,monospace;width:40px;text-align:center;flex-shrink:0}
.player .time:last-child{text-align:right}
.player .bar{
  flex:1;height:5px;border-radius:3px;background:var(--panel2);cursor:pointer;
  position:relative;overflow:hidden
}
.player .bar i{
  position:absolute;left:0;top:0;bottom:0;width:0;
  background:linear-gradient(90deg,var(--acc),var(--acc-deep));border-radius:3px
}
.player .row{display:flex;align-items:center;gap:14px;margin-top:7px}
.player .art{
  width:42px;height:42px;border-radius:12px;flex-shrink:0;
  background:linear-gradient(135deg,var(--acc-soft),transparent);
  border:1px solid var(--hair2);display:flex;align-items:center;justify-content:center;color:var(--acc)
}
.player .art svg{width:20px;height:20px}
.player .tit{flex:1;min-width:0}
.player .tit .n{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.player .tit .s{font-size:10.5px;color:var(--dim);margin-top:1px}
.player .ctr{display:flex;align-items:center;gap:4px;flex-shrink:0}
.player .ctr button{
  width:38px;height:38px;border:0;background:none;color:var(--sub);
  border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s
}
.player .ctr button:hover{color:var(--txt);background:var(--panel2)}
.player .ctr button svg{width:19px;height:19px}
.player .ctr .play{width:44px;height:44px;background:linear-gradient(180deg,var(--acc),var(--acc-deep));color:#fff;box-shadow:0 4px 14px var(--acc-soft)}
.player .ctr .play:hover{color:#fff;background:linear-gradient(180deg,var(--acc-deep),var(--acc))}
.player .ctr .play svg{width:20px;height:20px}
/* toast */
.toast{
  position:fixed;left:50%;bottom:calc(var(--bar-h) + 24px);transform:translateX(-50%) translateY(8px);
  background:var(--elev);color:var(--txt);font-size:12.5px;padding:9px 16px;border-radius:10px;
  border:1px solid var(--hair2);box-shadow:var(--sh);opacity:0;pointer-events:none;
  transition:.2s;z-index:99;max-width:82%;text-align:center
}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.err{border-color:rgba(251,113,133,.4);color:#fda4af}
/* modal */
.modal{
  position:fixed;inset:0;background:rgba(4,6,10,.55);z-index:80;display:none;
  align-items:flex-end;justify-content:center;backdrop-filter:blur(4px)
}
.modal.show{display:flex}
.modal .sheet{
  width:100%;max-width:640px;background:var(--panel);border-radius:20px 20px 0 0;
  padding:20px 18px calc(20px + env(safe-area-inset-bottom));
  border-top:1px solid var(--hair2);animation:slide .25s ease
}
@keyframes slide{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}
.modal h3{font-size:15px;font-weight:700;margin-bottom:4px}
.modal .hint{font-size:11.5px;color:var(--dim);margin-bottom:16px}
.modal input{
  width:100%;height:46px;border:1px solid var(--hair2);border-radius:12px;
  background:var(--panel2);color:var(--txt);padding:0 14px;font-size:14px;outline:0
}
.modal input:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-soft)}
.modal .btns{display:flex;gap:10px;margin-top:16px}
.modal .btns button{
  flex:1;height:44px;border-radius:12px;border:0;font-size:14px;font-weight:600;cursor:pointer
}
.modal .btn-ok{background:linear-gradient(180deg,var(--acc),var(--acc-deep));color:#fff}
.modal .btn-no{background:var(--panel2);color:var(--sub)}
@media (min-width:640px){
  .modal{align-items:center}
  .modal .sheet{border-radius:20px;max-width:400px}
}
/* toolbar / 视图切换 */
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.toolbar .sp{flex:1}
.seg{display:flex;background:var(--panel);border:1px solid var(--hair);border-radius:12px;padding:3px}
.seg button{border:0;background:none;color:var(--sub);font-size:13px;font-weight:600;height:30px;padding:0 16px;border-radius:9px;cursor:pointer}
.seg button.on{background:var(--acc-soft);color:var(--acc)}
.toolbar select{height:36px;background:var(--panel);color:var(--sub);border:1px solid var(--hair);border-radius:11px;padding:0 10px;font-size:12.5px;outline:0}
.tbtn{height:36px;padding:0 14px;border-radius:11px;border:1px solid var(--hair2);background:var(--panel);color:var(--sub);font-size:12.5px;font-weight:600;cursor:pointer}
.tbtn:hover{border-color:var(--acc);color:var(--acc)}
.tbtn.pri{background:linear-gradient(180deg,var(--acc),var(--acc-deep));color:#fff;border-color:transparent}
.tbtn.pri:hover{color:#fff}
.tbtn.admin-only{display:none}
body.admin .tbtn.admin-only{display:inline-block}
/* 专辑 */
.albums{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px}
.album{background:var(--panel);border:1px solid var(--hair);border-radius:var(--r);padding:10px;cursor:pointer;transition:.15s;min-width:0}
.album:hover{border-color:var(--hair2);transform:translateY(-1px)}
.acv{background:var(--panel2) center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:var(--dim)}
.acv svg{width:34px;height:34px;opacity:.6}
.album .acv{aspect-ratio:1/1;border-radius:11px;margin-bottom:9px}
.album .an{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.album .as{font-size:11px;color:var(--dim);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ahead{display:flex;gap:14px;align-items:center;margin-bottom:14px}
.ahead .acv{width:96px;height:96px;border-radius:14px;flex-shrink:0}
.ahead .ai{flex:1;min-width:0}
.ahead .an{font-size:17px;font-weight:700;overflow:hidden;text-overflow:ellipsis}
.ahead .as{font-size:12px;color:var(--dim);margin:3px 0 10px}
.ahead .ab{display:flex;gap:8px;flex-wrap:wrap}
/* 整理顺序 */
.track .mv{display:none;gap:3px;flex-shrink:0}
body.reorder .track .mv{display:flex}
body.reorder .track .del,body.reorder .track .edit{display:none!important}
.track .mv button{width:30px;height:30px;border-radius:8px;border:0;background:var(--panel2);color:var(--sub);cursor:pointer;font-size:12px}
.track .mv button:hover{color:var(--acc);background:var(--acc-soft)}
/* 播放栏:模式 / 列表按钮 */
.player .mini{width:30px;height:30px;border:0;background:none;color:var(--sub);border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.player .mini:hover{color:var(--txt);background:var(--panel2)}
.player .mini.on{color:var(--acc)}
.player .mini svg{width:17px;height:17px}
.player .prog .time{text-align:center}
/* 展开的播放列表 */
.queue{position:absolute;left:0;right:0;bottom:100%;display:none;pointer-events:none}
.queue.show{display:block}
.queue .qin{
  pointer-events:auto;max-width:640px;margin:0 auto;background:var(--panel);
  border:1px solid var(--hair2);border-bottom:0;border-radius:18px 18px 0 0;box-shadow:var(--sh);
  max-height:min(55vh,460px);display:flex;flex-direction:column;animation:slide .2s ease
}
.queue .qh{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--hair);font-size:13px;font-weight:700}
.queue .qh span{flex:1}
.queue .qh small{color:var(--acc);font-weight:600;font-size:11.5px}
.queue .qh button{border:0;background:none;color:var(--dim);font-size:22px;cursor:pointer;line-height:1;padding:0 4px}
.queue .ql{overflow:auto;padding:6px;position:relative}
.qi{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;cursor:pointer}
.qi:hover{background:var(--panel2)}
.qi.cur{background:var(--acc-soft)}
.qi .qn{width:22px;text-align:center;font-size:11px;color:var(--dim);font-family:ui-monospace,Menlo,monospace;flex-shrink:0}
.qi.cur .qn{color:var(--acc)}
.qi .qm{flex:1;min-width:0}
.qi .qt{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qi .qs{font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qempty{padding:24px;text-align:center;color:var(--dim);font-size:12.5px}
/* 顶部:主题 / 站点设置按钮、自定义 Logo */
header{gap:8px}
.hbtn{flex-shrink:0}
.hbtn.adm{display:none}
body.admin .hbtn.adm{display:flex}
.brand .bt{min-width:0}
.brand h1{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brand .ver{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brand .logo.custom{background:none;box-shadow:none;overflow:hidden}
.brand .logo.custom img{width:100%;height:100%;object-fit:cover;border-radius:14px;display:block}
html[data-theme="light"] .toast.err{color:#c92a2a;border-color:rgba(224,49,49,.35)}
html[data-theme="light"] .modal{background:rgba(20,24,36,.35)}
/* 播放栏封面:必须写在原 .player .art 的 background 简写之后,否则 size 会被重置 */
.player .art{background-size:cover;background-position:center;background-repeat:no-repeat}
/* 禁止缩放 / 长按菜单 / 选中文字 / 下拉回弹(输入框除外) */
html{touch-action:pan-x pan-y;-webkit-text-size-adjust:100%;text-size-adjust:100%;overscroll-behavior-y:none}
body{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
input,textarea{-webkit-user-select:text;user-select:text;-webkit-touch-callout:default}
@media (pointer:coarse){.search input,.modal input{font-size:16px}}
/* 黑胶全屏播放页:不创建第二个音频实例 */
.player[hidden]{display:none!important}
.player .art{cursor:pointer;padding:0;appearance:none;-webkit-appearance:none}
.player .art:focus-visible{outline:2px solid var(--acc);outline-offset:3px}
.toast{bottom:calc(20px + env(safe-area-inset-bottom));z-index:140}
body.has-player .toast{bottom:calc(var(--bar-h) + 18px)}
body.now-open .toast{bottom:calc(24px + env(safe-area-inset-bottom))}
.now-player{
  position:fixed;inset:0;z-index:70;display:none;height:100vh;height:100dvh;
  overflow:auto;overscroll-behavior:contain;color:#fff;color-scheme:dark;
  background:radial-gradient(ellipse at 70% 20%,#313239,transparent 66%),#090a0d;
  -webkit-user-select:none;user-select:none
}
.now-player.open{display:block}
.now-bg,.now-shade{position:absolute;inset:0;pointer-events:none}
.now-bg{inset:-50px;background:center/cover no-repeat;filter:blur(35px) saturate(.6);opacity:.55;transition:opacity .4s}
.now-bg.is-custom{inset:0;filter:none;opacity:.78}
.now-shade{background:linear-gradient(180deg,rgba(0,0,0,.32),rgba(0,0,0,.12) 35%,rgba(0,0,0,.58) 75%,rgba(0,0,0,.8))}
.now-inner{
  position:relative;max-width:560px;margin:0 auto;height:100%;min-height:680px;
  display:flex;flex-direction:column;padding:calc(12px + env(safe-area-inset-top)) 26px calc(18px + env(safe-area-inset-bottom))
}
.now-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0;height:44px}
.now-top .now-label{flex:1;min-width:0;text-align:center}
.now-top .now-label b{display:block;font-size:14px;font-weight:500;letter-spacing:2px}
.now-top .now-label span{display:block;max-width:100%;font-size:10px;color:rgba(255,255,255,.45);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin-top:2px}
.now-btn{
  border:0;background:none;color:rgba(255,255,255,.85);cursor:pointer;width:44px;height:44px;
  border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:0
}
.now-btn:hover{background:rgba(255,255,255,.08);color:#fff}
.now-btn:focus-visible{outline:2px solid #fff;outline-offset:4px}
.now-btn svg{width:24px;height:24px}
.now-btn.admin-only{visibility:hidden;pointer-events:none}
body.admin .now-btn.admin-only{visibility:visible;pointer-events:auto}
.now-stage{display:flex;align-items:center;justify-content:center;flex:1;min-height:340px;padding:65px 0 20px}
.now-deck{position:relative;flex-shrink:0;width:min(86vw,432px,49dvh);aspect-ratio:1/1;max-width:100%}
.now-disc{
  width:100%;height:100%;position:relative;display:flex;align-items:center;justify-content:center;border-radius:50%;
  border:1px solid rgba(255,255,255,.13);
  background:repeating-radial-gradient(circle at center,transparent 0 2px,rgba(255,255,255,.045) 2px 3px,transparent 3px 5px),conic-gradient(from 25deg,#141414,#353535 15%,#161616 27%,#0e0e0e 38%,#3a3a3a 56%,#151515 72%,#313131 86%,#141414);
  box-shadow:0 0 0 7px rgba(0,0,0,.24),0 0 0 9px rgba(255,255,255,.03),0 24px 55px rgba(0,0,0,.55);
  animation:vinyl-turn 18s linear infinite;animation-play-state:paused
}
.now-player.open.is-playing .now-disc{animation-play-state:running}
@keyframes vinyl-turn{to{transform:rotate(360deg)}}
.now-disc::before{content:"";position:absolute;inset:4%;border:1px solid rgba(255,255,255,.1);border-radius:50%;pointer-events:none}
.now-disc::after{content:"";position:absolute;left:50%;top:50%;width:9px;height:9px;transform:translate(-50%,-50%);border-radius:50%;background:#c5c5c5;box-shadow:0 0 0 4px rgba(0,0,0,.2);pointer-events:none}
.now-cover{width:63%;height:63%;border-radius:50%;background:#28292e center/cover no-repeat;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 0 0 2px rgba(0,0,0,.6);color:rgba(255,255,255,.4)}
.now-cover svg{width:42%;height:42%}
.now-cover.hascv svg{display:none}
.now-arm{position:absolute;z-index:3;width:48%;height:67%;left:50%;top:-24%;transform-origin:11.8% 8.4%;transform:rotate(-28deg);transition:transform .75s cubic-bezier(.2,.7,.25,1);pointer-events:none;filter:drop-shadow(3px 7px 6px rgba(0,0,0,.45))}
.now-player.is-playing .now-arm{transform:rotate(0)}
.now-bottom{flex-shrink:0;padding-bottom:3px}
.now-track{display:flex;align-items:center;gap:12px;margin-bottom:26px}
.now-track .now-meta{min-width:0;flex:1}
.now-title{font-size:23px;line-height:1.35;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.2px}
.now-artist{font-size:14px;color:rgba(255,255,255,.6);margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.now-track .now-badge{font-size:10px;letter-spacing:1px;border:1px solid rgba(255,255,255,.24);border-radius:5px;padding:3px 7px;color:rgba(255,255,255,.55);flex-shrink:0}
.now-progress{margin:0 0 22px}
.now-seek{display:block;width:100%;height:18px;margin:0;border:0;outline:0;cursor:pointer;appearance:none;-webkit-appearance:none;background:transparent;--seek:0%;touch-action:pan-x}
.now-seek::-webkit-slider-runnable-track{height:3px;border-radius:3px;background:linear-gradient(to right,rgba(255,255,255,.9) var(--seek),rgba(255,255,255,.22) var(--seek))}
.now-seek::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:11px;height:11px;border-radius:50%;background:#fff;margin-top:-4px;box-shadow:0 0 0 5px rgba(255,255,255,.04)}
.now-seek::-moz-range-track{height:3px;background:rgba(255,255,255,.22)}
.now-seek::-moz-range-progress{height:3px;background:rgba(255,255,255,.9)}
.now-seek::-moz-range-thumb{width:11px;height:11px;border:0;border-radius:50%;background:#fff}
.now-seek:focus-visible{outline:1px solid rgba(255,255,255,.7);outline-offset:5px}
.now-times{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:3px;color:rgba(255,255,255,.45);font-size:10.5px;font-variant-numeric:tabular-nums}
.now-status{text-align:center;font-size:10px;letter-spacing:1px}
.now-controls{display:flex;align-items:center;justify-content:space-between;gap:12px}
.now-controls .now-btn svg{width:26px;height:26px}
.now-controls .now-play{width:72px;height:72px}
.now-controls .now-play svg{width:48px;height:48px}
.now-controls .now-btn.active{color:#fff}
.now-controls .now-btn.active::after{content:"";position:absolute;bottom:2px;width:3px;height:3px;border-radius:50%;background:#fff}
.now-controls .now-btn{position:relative}
.now-foot{margin-top:13px;text-align:center;color:rgba(255,255,255,.3);font-size:10px;letter-spacing:2px}
/* 队列可在全屏页及暂停状态独立显示 */
body.now-open .queue{position:fixed;z-index:90;inset:0;pointer-events:auto;background:rgba(0,0,0,.4);display:none;align-items:flex-end;justify-content:center}
body.now-open .queue.show{display:flex}
body.now-open .queue .qin{width:100%;max-width:560px;max-height:min(62dvh,520px);padding-bottom:env(safe-area-inset-bottom);margin:0;color:var(--txt)}
body.now-open .queue .ql{min-height:0}
#sBgBox{width:84px;height:116px;border-radius:12px;background-position:center;background-size:cover}
.bg-hint{font-size:11px;color:var(--dim);line-height:1.6;margin:4px 0 0}
@media(max-height:740px){.now-inner{min-height:570px;padding-top:calc(5px + env(safe-area-inset-top));padding-bottom:calc(12px + env(safe-area-inset-bottom))}.now-stage{min-height:270px;padding-top:52px;padding-bottom:15px}.now-deck{width:min(78vw,370px,45dvh)}.now-track{margin-bottom:16px}.now-progress{margin-bottom:12px}.now-foot{margin-top:6px}.now-title{font-size:21px}}
@media(orientation:landscape) and (max-height:560px){.now-inner{min-height:500px}.now-deck{width:230px}.now-stage{min-height:265px}.now-top{height:36px}}
@media(prefers-reduced-motion:reduce){.now-player.open{animation:none}.now-arm{transition:none}.now-disc{animation-duration:36s}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      %%LOGO%%
      <div class="bt"><h1 id="siteName">%%NAME%%</h1><div class="ver" id="siteSub">%%SUB%%</div></div>
    </div>
    <button class="hbtn" id="btnTheme" title="切换主题"></button>
    <button class="hbtn adm" id="btnSite" title="站点设置(名称 / Logo / 播放背景)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    <button class="hbtn" id="btnAdmin" title="管理(上传/删除)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></button>
  </header>

  <div class="search">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
    <input id="q" placeholder="搜索歌曲…" autocomplete="off">
    <span class="clear" id="qClear">×</span>
  </div>

  <div class="toolbar">
    <div class="seg" id="seg"><button id="vSongs" class="on">歌曲</button><button id="vAlbums">专辑</button></div>
    <select id="sortSel" title="排序方式">
      <option value="custom">自定义顺序</option>
      <option value="name">按文件名</option>
      <option value="title">按歌名</option>
      <option value="artist">按作者</option>
      <option value="new">最新上传</option>
    </select>
    <span class="sp"></span>
    <button class="tbtn admin-only" id="btnReorder">整理顺序</button>
    <button class="tbtn" id="btnReorderCancel" style="display:none">取消</button>
    <button class="tbtn pri" id="btnReorderSave" style="display:none">保存顺序</button>
  </div>

  <div class="upload-strip" id="upStrip">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>
    <div class="u-txt"><b>上传音乐</b> · mp3 / m4a / flac / ogg / wav,单文件 ≤ 50MB</div>
    <div class="u-progress"><i id="upBar"></i></div>
    <input type="file" id="upInput" accept=".mp3,.m4a,.flac,.ogg,.oga,.wav,.aac,.opus,.weba,audio/*" multiple hidden>
  </div>

  <div id="albumHead"></div>
  <div class="list" id="list"></div>
  <div class="empty" id="empty" style="display:none">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
    <div class="t1" id="emptyT1">还没有音乐</div>
    <div class="t2" id="emptyT2">点击右上角锁形按钮,登录后上传第一首</div>
  </div>
</div>

<div class="player" id="playerBar" hidden aria-hidden="true">
  <div class="queue" id="queue">
    <div class="qin">
      <div class="qh"><span id="qTitle">播放列表</span><small id="qMode"></small><button id="qClose" title="收起">×</button></div>
      <div class="ql" id="qList"></div>
    </div>
  </div>
  <div class="prog">
    <button class="mini" id="btnMode" title="顺序循环"></button>
    <span class="time" id="curT">0:00</span>
    <div class="bar" id="pBar"><i id="pFill"></i></div>
    <span class="time" id="durT">-:--</span>
    <button class="mini" id="btnQueue" title="播放列表"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>
  </div>
  <div class="row">
    <button class="art" id="playerArt" title="打开黑胶播放页" aria-label="打开黑胶播放页"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></button>
    <div class="tit">
      <div class="n" id="pName">未在播放</div>
      <div class="s" id="pSub">从列表选择一首开始</div>
    </div>
    <div class="ctr">
      <button id="btnPrev" title="上一首"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg></button>
      <button class="play" id="btnPlay" title="播放/暂停"><svg id="icPlay" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><svg id="icPause" style="display:none" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg></button>
      <button id="btnNext" title="下一首"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button>
    </div>
  </div>
</div>

<section class="now-player" id="nowPlaying" role="dialog" aria-modal="true" aria-label="黑胶播放页" aria-hidden="true" tabindex="-1">
  <div class="now-bg" id="nowBg" data-background="%%PLAYER_BG%%"></div>
  <div class="now-shade"></div>
  <div class="now-inner">
    <div class="now-top">
      <button class="now-btn" id="nowClose" title="收起播放页" aria-label="收起播放页"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 9 7 7 7-7"/></svg></button>
      <div class="now-label"><b>正在播放</b><span id="nowAlbum">黑胶唱片</span></div>
      <button class="now-btn admin-only" id="nowBackground" title="自定义播放页背景" aria-label="自定义播放页背景"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/></svg></button>
    </div>
    <div class="now-stage">
      <div class="now-deck">
        <div class="now-disc" id="nowDisc">
          <div class="now-cover" id="nowCover"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
        </div>
        <svg class="now-arm" viewBox="0 0 170 240" fill="none" aria-hidden="true">
          <defs><linearGradient id="armMetal" x1="10" y1="80" x2="51" y2="75" gradientUnits="userSpaceOnUse"><stop stop-color="#8f8f8f"/><stop offset=".48" stop-color="#f4f4f4"/><stop offset="1" stop-color="#a0a0a0"/></linearGradient></defs>
          <circle cx="20" cy="20" r="20" fill="#171717"/><circle cx="20" cy="20" r="12" fill="#aaa"/><circle cx="20" cy="20" r="5" fill="#666"/>
          <path d="M20 20C24 65 31 103 53 140L119 204" stroke="url(#armMetal)" stroke-width="9" stroke-linecap="round"/>
          <path d="M20 20C24 65 31 103 53 140L119 204" stroke="white" stroke-opacity=".35" stroke-width="2" stroke-linecap="round"/>
          <g transform="rotate(-44 126 209)"><rect x="115" y="188" width="23" height="40" rx="5" fill="#cecece"/><rect x="120" y="198" width="13" height="22" rx="2" fill="#e5e5e5"/><path d="M126 228v7" stroke="#aaa" stroke-width="3"/></g>
        </svg>
      </div>
    </div>
    <div class="now-bottom">
      <div class="now-track"><div class="now-meta"><div class="now-title" id="nowTitle">未在播放</div><div class="now-artist" id="nowArtist">选择一首喜欢的音乐</div></div><span class="now-badge">黑胶</span></div>
      <div class="now-progress">
        <input class="now-seek" id="nowSeek" type="range" min="0" max="1000" value="0" step="1" aria-label="播放进度" disabled>
        <div class="now-times"><span id="nowCur">0:00</span><span class="now-status" id="nowStatus" aria-live="polite">已暂停</span><span id="nowDur">-:--</span></div>
      </div>
      <div class="now-controls">
        <button class="now-btn" id="nowMode" title="顺序循环" aria-label="切换播放模式"></button>
        <button class="now-btn" id="nowPrev" title="上一首" aria-label="上一首"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg></button>
        <button class="now-btn now-play" id="nowPlay" title="播放" aria-label="播放"><svg id="nowPlayIcon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><svg id="nowPauseIcon" style="display:none" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg></button>
        <button class="now-btn" id="nowNext" title="下一首" aria-label="下一首"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button>
        <button class="now-btn" id="nowQueue" title="播放列表" aria-label="播放列表"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 5l3 2-3 2zM3 12h.01M3 18h.01"/></svg></button>
      </div>
      <div class="now-foot">让音乐慢慢转起来</div>
    </div>
  </div>
</section>

<div class="modal" id="loginModal">
  <div class="sheet">
    <h3>管理员登录</h3>
    <div class="hint">输入管理令牌后即可上传 / 删除音乐</div>
    <input type="password" id="tok" placeholder="管理令牌" autocomplete="off">
    <div class="btns">
      <button class="btn-no" id="btnLoginNo">取消</button>
      <button class="btn-ok" id="btnLoginOk">登录</button>
    </div>
  </div>
</div>

<div class="modal" id="delModal">
  <div class="sheet">
    <h3>删除这首歌?</h3>
    <div class="hint" id="delName"></div>
    <div class="btns">
      <button class="btn-no" id="btnDelNo">取消</button>
      <button class="btn-ok" style="background:linear-gradient(180deg,#fb7185,#e0455e)" id="btnDelOk">删除</button>
    </div>
  </div>
</div>

<div class="modal" id="editModal">
  <div class="sheet">
    <h3>编辑歌曲信息</h3>
    <div class="hint" id="editFile"></div>
    <div class="cvrow">
      <div class="cvbox" id="cvBox">点击选择封面</div>
      <div class="cvbtns">
        <button id="cvPick">选择封面</button>
        <button id="cvClear">移除封面</button>
      </div>
    </div>
    <input type="file" id="cvInput" accept="image/*" hidden>
    <div class="lbl">歌名</div><input id="eTitle" maxlength="200" placeholder="留空则显示文件名" autocomplete="off">
    <div class="lbl">作者</div><input id="eArtist" maxlength="200" autocomplete="off" list="artistList">
    <div class="lbl">专辑(相同专辑名的歌会归到一起)</div><input id="eAlbum" maxlength="200" autocomplete="off" list="albumList">
    <datalist id="artistList"></datalist><datalist id="albumList"></datalist>
    <div class="btns">
      <button class="btn-no" id="btnEditNo">取消</button>
      <button class="btn-ok" id="btnEditOk">保存</button>
    </div>
  </div>
</div>

<div class="modal" id="siteModal">
  <div class="sheet">
    <h3>站点设置</h3>
    <div class="hint">自定义站点名称、Logo 和黑胶播放页背景,保存后所有设备共用</div>
    <div class="cvrow">
      <div class="cvbox" id="sLogoBox">点击选择 Logo</div>
      <div class="cvbtns">
        <button id="sPick">选择 Logo</button>
        <button id="sClear">恢复默认</button>
      </div>
    </div>
    <input type="file" id="sInput" accept="image/*" hidden>
    <div class="lbl">站点名称</div><input id="sName" maxlength="30" autocomplete="off">
    <div class="lbl">副标题(留空显示默认)</div><input id="sSub" maxlength="60" autocomplete="off">
    <div class="lbl">黑胶播放页背景</div>
    <div class="cvrow">
      <div class="cvbox" id="sBgBox" role="button" tabindex="0" aria-label="选择播放页背景">点击选择<br>背景图</div>
      <div class="cvbtns"><button id="sBgPick">选择背景图</button><button id="sBgClear">恢复封面背景</button><div class="bg-hint">推荐竖图 · 图片自动压缩<br>支持 JPG / PNG / WebP / GIF,最大 5MB</div></div>
    </div>
    <input type="file" id="sBgInput" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
    <div class="bg-hint" id="sBgHint">不设置时,自动用当前歌曲封面作为模糊背景</div>
    <div class="btns">
      <button class="btn-no" id="btnSiteNo">取消</button>
      <button class="btn-ok" id="btnSiteOk">保存</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
(function(){
  // ---------- 状态 ----------
  var list=[], map={}, order=[], playing=null;
  var token=''; try{token=sessionStorage.getItem('r2m_token')||''}catch(e){}
  var view='songs', albumOpen=null, sortMode='custom', mode='loop';
  var reorderOn=false, workOrder=[];
  var queue=[], hist=[], bag=[];
  var lastPos={}, pStatus='', curSub='', resumeAt=0;
  var SORTS=['custom','name','title','artist','new'];
  var MODE_NAMES={loop:'顺序循环',shuffle:'随机播放',one:'单曲循环'};
  var NOTE='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  var SVG_A='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  var MODE_ICONS={
    loop:SVG_A+'<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    shuffle:SVG_A+'<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
    one:SVG_A+'<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/></svg>'
  };
  function lsGet(k,d){try{var v=localStorage.getItem(k);return v==null?d:v}catch(e){return d}}
  function lsSet(k,v){try{localStorage.setItem(k,v)}catch(e){}}
  view=lsGet('r2m_view','songs')==='albums'?'albums':'songs';
  sortMode=lsGet('r2m_sort','custom'); if(SORTS.indexOf(sortMode)<0)sortMode='custom';
  mode=lsGet('r2m_mode','loop'); if(!MODE_NAMES[mode])mode='loop';

  var audio=new Audio(); audio.preload='metadata';
  function $(id){return document.getElementById(id)}
  var qEl=$('q'), listEl=$('list'), emptyEl=$('empty'), emptyT1=$('emptyT1'), emptyT2=$('emptyT2'),
      upStrip=$('upStrip'), upInput=$('upInput'), albumHead=$('albumHead'),
      pName=$('pName'), pSubEl=$('pSub'), artEl=document.querySelector('.player .art'),
      // 副标题 = "作者 · 专辑 · 状态";所有 pSub.textContent=... 赋值只更新状态部分
      pSub={set textContent(v){pStatus=v;pSubEl.textContent=(curSub?curSub+' · ':'')+v;if(nowStatus)nowStatus.textContent=v},get textContent(){return pStatus}},
      pBar=$('pBar'), pFill=$('pFill'), curT=$('curT'), durT=$('durT'),
      btnPlay=$('btnPlay'), icPlay=$('icPlay'), icPause=$('icPause'),
      btnMode=$('btnMode'), btnQueue=$('btnQueue'), queueEl=$('queue'), qList=$('qList'), qTitle=$('qTitle'), qModeEl=$('qMode'),
      vSongs=$('vSongs'), vAlbums=$('vAlbums'), sortSel=$('sortSel'),
      btnReorder=$('btnReorder'), btnRSave=$('btnReorderSave'), btnRCancel=$('btnReorderCancel'),
      playerBar=$('playerBar'), nowPlayer=$('nowPlaying'), nowCover=$('nowCover'), nowBg=$('nowBg'),
      nowTitle=$('nowTitle'), nowArtist=$('nowArtist'), nowStatus=$('nowStatus'), nowSeek=$('nowSeek'),
      nowCur=$('nowCur'), nowDur=$('nowDur'), nowPlay=$('nowPlay'), nowMode=$('nowMode'), nowQueue=$('nowQueue');
  var nowOpen=false, pageScroll=0, seekEditing=false, buffering=false, playFailed=false;
  var siteBackground=nowBg.getAttribute('data-background')||'';
  function setPlayerBackground(){
    var f=map[playing], u=siteBackground||(f&&f.cover)||'';
    nowBg.style.backgroundImage=u?'url('+JSON.stringify(u)+')':'';
    nowBg.classList.toggle('is-custom',!!siteBackground);
  }
  function updateBarHeight(){
    if(!playerBar.hidden)document.documentElement.style.setProperty('--bar-h',Math.ceil(playerBar.getBoundingClientRect().height)+'px');
  }
  function syncPlayback(){
    var active=!!playing&&!audio.paused&&!audio.ended&&!audio.error&&!playFailed;
    var showBar=active&&!nowOpen;
    playerBar.hidden=!showBar;
    playerBar.setAttribute('aria-hidden',String(!showBar));
    document.body.classList.toggle('has-player',showBar);
    nowPlayer.classList.toggle('is-playing',active&&!buffering);
    icPlay.style.display=active?'none':'block';icPause.style.display=active?'block':'none';
    $('nowPlayIcon').style.display=active?'none':'block';$('nowPauseIcon').style.display=active?'block':'none';
    btnPlay.title=nowPlay.title=active?'暂停':'播放';
    btnPlay.setAttribute('aria-label',btnPlay.title);nowPlay.setAttribute('aria-label',nowPlay.title);
    if(!showBar&&!nowOpen)toggleQueue(false);
    updateBarHeight();
    if('mediaSession' in navigator){try{navigator.mediaSession.playbackState=active?'playing':(playing?'paused':'none')}catch(e){}}
  }
  function syncProgress(){
    var d=isFinite(audio.duration)&&audio.duration>0?audio.duration:0;
    var t=Math.max(0,audio.currentTime||0), pct=d?Math.max(0,Math.min(100,t/d*100)):0;
    pFill.style.width=pct+'%';curT.textContent=t>0?fmtTime(t):'0:00';
    durT.textContent=nowDur.textContent=d?fmtTime(d):'-:--';
    nowSeek.disabled=!d;
    if(!seekEditing){nowSeek.value=Math.round(pct*10);nowSeek.style.setProperty('--seek',pct+'%');nowCur.textContent=curT.textContent}
    nowSeek.setAttribute('aria-valuetext',nowCur.textContent+' / '+nowDur.textContent);
  }
  function openNow(){
    if(!playing||!map[playing])return;
    toggleQueue(false);pageScroll=window.scrollY||0;nowOpen=true;
    document.body.appendChild(queueEl);
    document.querySelector('.wrap').setAttribute('inert','');
    document.body.style.top=-pageScroll+'px';document.body.classList.add('now-open');
    nowPlayer.classList.add('open');nowPlayer.setAttribute('aria-hidden','false');
    applyNow(map[playing]);syncProgress();syncPlayback();
    try{$('nowClose').focus({preventScroll:true})}catch(e){}
  }
  function closeNow(){
    if(!nowOpen)return;
    toggleQueue(false);nowOpen=false;seekEditing=false;
    playerBar.insertBefore(queueEl,playerBar.firstChild);
    nowPlayer.classList.remove('open');nowPlayer.setAttribute('aria-hidden','true');
    document.querySelector('.wrap').removeAttribute('inert');
    document.body.classList.remove('now-open');document.body.style.top='';
    window.scrollTo(0,pageScroll);syncPlayback();
    var target=playerBar.hidden?listEl:artEl;
    if(target===listEl)target.setAttribute('tabindex','-1');
    try{target.focus({preventScroll:true})}catch(e){}
  }
  function stopPlayback(){
    audio.pause();playing=null;resumeAt=0;playFailed=false;buffering=false;
    closeNow();curSub='';pName.textContent=nowTitle.textContent='未在播放';
    pSub.textContent='从列表选择一首开始';nowArtist.textContent='选择一首喜欢的音乐';
    artEl.style.backgroundImage=nowCover.style.backgroundImage='';
    artEl.classList.remove('hascv');nowCover.classList.remove('hascv');
    audio.removeAttribute('src');audio.load();
    setPlayerBackground();syncProgress();syncPlayback();
    if('mediaSession' in navigator){try{navigator.mediaSession.metadata=null}catch(e){}}
  }
  artEl.addEventListener('click',openNow);
  $('nowClose').addEventListener('click',closeNow);
  nowPlay.addEventListener('click',toggle);
  $('nowPrev').addEventListener('click',function(){step(-1)});
  $('nowNext').addEventListener('click',function(){step(1)});
  nowMode.addEventListener('click',function(){setMode(mode==='loop'?'shuffle':(mode==='shuffle'?'one':'loop'))});
  nowQueue.addEventListener('click',function(){toggleQueue()});
  $('nowBackground').addEventListener('click',function(){if(adminOn){toggleQueue(false);openSite()}});
  nowSeek.addEventListener('input',function(){
    seekEditing=true;nowSeek.style.setProperty('--seek',Number(nowSeek.value)/10+'%');
    var t=(audio.duration||0)*Number(nowSeek.value)/1000;nowCur.textContent=t>0?fmtTime(t):'0:00';
  });
  function commitSeek(){
    if(!nowSeek.disabled){try{audio.currentTime=audio.duration*Number(nowSeek.value)/1000}catch(e){}}
    seekEditing=false;syncProgress();
  }
  nowSeek.addEventListener('change',commitSeek);
  nowSeek.addEventListener('blur',function(){if(seekEditing)commitSeek()});
  nowSeek.addEventListener('pointercancel',function(){seekEditing=false;syncProgress()});
  queueEl.addEventListener('click',function(e){if(e.target===queueEl)toggleQueue(false)});
  window.addEventListener('resize',updateBarHeight);
  if(window.ResizeObserver)new ResizeObserver(updateBarHeight).observe(playerBar);
  setPlayerBackground();

  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function fmtBytes(n){if(n==null)return'--';if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';return(n/1048576).toFixed(1)+' MB'}
  function fmtTime(s){if(!isFinite(s)||s<=0)return'-:--';s=Math.floor(s);var m=Math.floor(s/60),ss=s%60;return m+':'+(ss<10?'0':'')+ss}
  function toast(msg,err){var t=$('toast');t.textContent=msg;t.className='toast show'+(err?' err':'');clearTimeout(t._h);t._h=setTimeout(function(){t.className='toast'},2200)}
  function bgUrl(u){return 'background-image:url('+esc(JSON.stringify(u))+')'}

  // ---------- 排序 / 分组 ----------
  function cmpStr(a,b){return String(a).localeCompare(String(b),'zh')}
  function sortFiles(arr,m,ord){
    var a=arr.slice(), pos=Object.create(null), BIG=1e9;
    (ord||[]).forEach(function(n,i){pos[n]=i});
    if(m==='custom'){
      a.sort(function(x,y){
        var px=x.name in pos?pos[x.name]:BIG, py=y.name in pos?pos[y.name]:BIG;
        return px!==py?px-py:cmpStr(x.name,y.name);
      });
    }else if(m==='name'){
      a.sort(function(x,y){return cmpStr(x.name,y.name)});
    }else if(m==='title'){
      a.sort(function(x,y){return cmpStr(x.title||x.name,y.title||y.name)});
    }else if(m==='artist'){
      a.sort(function(x,y){
        if(!x.artist!==!y.artist)return x.artist?-1:1;
        return cmpStr(x.artist||'',y.artist||'')||cmpStr(x.title||x.name,y.title||y.name);
      });
    }else if(m==='new'){
      a.sort(function(x,y){return new Date(y.uploaded)-new Date(x.uploaded)});
    }
    return a;
  }
  function groupAlbums(){
    var g=Object.create(null), keys=[];
    sortFiles(list,sortMode,order).forEach(function(f){
      var k=f.album||'';
      if(!(k in g)){g[k]={key:k,name:k||'未分类',tracks:[],cover:'',artists:Object.create(null)};keys.push(k)}
      g[k].tracks.push(f);
      if(!g[k].cover&&f.cover)g[k].cover=f.cover;
      if(f.artist)g[k].artists[f.artist]=1;
    });
    keys.sort(function(a,b){if(a===''||b==='')return a===''?1:-1;return cmpStr(a,b)});
    return {map:g,keys:keys};
  }
  function artistLine(g){
    var a=Object.keys(g.artists);
    return a.length===1?a[0]+' · ':(a.length>1?'多位作者 · ':'');
  }

  // ---------- 加载列表 ----------
  function load(){
    fetch('/api/list').then(function(r){return r.json()}).then(function(d){
      list=d.files||[];order=d.order||[];
      map={};list.forEach(function(f){map[f.name]=f});
      if(albumOpen!==null&&!list.some(function(f){return (f.album||'')===albumOpen}))albumOpen=null;
      render();
      var cur=map[playing];
      if(cur)applyNow(cur);else if(playing)stopPlayback();
      if(queueEl.classList.contains('show'))renderQueue();
    }).catch(function(e){toast('加载失败:'+e.message,1)});
  }

  // 当前界面上可见的歌曲(已按排序/搜索过滤)
  function visibleFiles(){
    if(reorderOn)return workOrder.map(function(n){return map[n]}).filter(Boolean);
    var kw=qEl.value.trim().toLowerCase();
    var base=list;
    if(view==='albums'&&albumOpen!==null)base=list.filter(function(f){return (f.album||'')===albumOpen});
    base=sortFiles(base,sortMode,order);
    if(!kw)return base;
    return base.filter(function(f){return [f.name,f.title,f.artist,f.album].join(' ').toLowerCase().indexOf(kw)>=0});
  }
  function visibleNames(){return visibleFiles().map(function(f){return f.name})}

  function updateToolbar(){
    vSongs.classList.toggle('on',view==='songs');
    vAlbums.classList.toggle('on',view==='albums');
    sortSel.value=sortMode;
    var albumList=view==='albums'&&albumOpen===null;
    sortSel.style.display=(albumList||reorderOn)?'none':'';
    btnReorder.style.display=(view==='songs'&&!reorderOn)?'':'none';
    btnRSave.style.display=btnRCancel.style.display=reorderOn?'':'none';
    $('seg').style.pointerEvents=reorderOn?'none':'';
    $('seg').style.opacity=reorderOn?'.5':'';
    document.body.classList.toggle('reorder',reorderOn);
  }

  function render(){
    updateToolbar();
    if(view==='albums'&&albumOpen===null){renderAlbums();return}
    renderTracks();
  }

  function showEmpty(t1,t2){listEl.innerHTML='';emptyEl.style.display='block';emptyT1.textContent=t1;emptyT2.textContent=t2}

  function renderAlbums(){
    albumHead.innerHTML='';
    listEl.className='albums';
    var kw=qEl.value.trim().toLowerCase();
    var gr=groupAlbums();
    var keys=gr.keys.filter(function(k){
      if(!kw)return true;
      var g=gr.map[k];
      var s=[g.name,Object.keys(g.artists).join(' ')].concat(g.tracks.map(function(f){return (f.title||'')+' '+f.name})).join(' ').toLowerCase();
      return s.indexOf(kw)>=0;
    });
    if(!keys.length){
      showEmpty(list.length?'没有匹配的专辑':'还没有专辑',list.length?'换个关键词试试':'上传音乐后,在歌曲的编辑里填写"专辑"即可归类');
      return;
    }
    emptyEl.style.display='none';
    listEl.innerHTML=keys.map(function(k){
      var g=gr.map[k];
      return '<div class="album" data-album="'+esc(k)+'">'
        +'<div class="acv" style="'+(g.cover?bgUrl(g.cover):'')+'">'+(g.cover?'':NOTE)+'</div>'
        +'<div class="an">'+esc(g.name)+'</div>'
        +'<div class="as">'+esc(artistLine(g))+g.tracks.length+' 首</div></div>';
    }).join('');
  }

  function trackHtml(f,i){
    var on=f.name===playing, sub=[f.artist,f.album].filter(Boolean).join(' · ');
    return '<div class="track'+(on?' playing':'')+(f.cover?' hascv':'')+'" data-name="'+esc(f.name)+'">'
      +(on?'<span class="playing-bar"></span>':'')
      +'<span class="idx">'+String(i+1).padStart(2,'0')+'</span>'
      +'<span class="ic"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>'
      +(f.cover?'<span class="cv" style="'+bgUrl(f.cover)+'"></span>':'')
      +'<span class="meta"><div class="name">'+esc(f.title||f.name)+'</div><div class="info">'+(sub?esc(sub)+' · ':'')+fmtBytes(f.size)+(f.dur?' · '+fmtTime(f.dur):'')+'</div></span>'
      +'<span class="mv"><button data-mv="top" title="置顶">⤒</button><button data-mv="up" title="上移">▲</button><button data-mv="down" title="下移">▼</button></span>'
      +'<button class="edit" title="编辑信息"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>'
      +'<button class="del" title="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>'
      +'</div>';
  }

  function renderTracks(){
    listEl.className='list';
    // 专辑详情头部
    if(view==='albums'&&albumOpen!==null){
      var g=groupAlbums().map[albumOpen];
      if(g){
        albumHead.innerHTML='<button class="tbtn" data-act="back" style="margin-bottom:12px">‹ 返回专辑</button>'
          +'<div class="ahead"><div class="acv" style="'+(g.cover?bgUrl(g.cover):'')+'">'+(g.cover?'':NOTE)+'</div>'
          +'<div class="ai"><div class="an">'+esc(g.name)+'</div><div class="as">'+esc(artistLine(g))+g.tracks.length+' 首</div>'
          +'<div class="ab"><button class="tbtn pri" data-act="playall">▶ 播放全部</button><button class="tbtn" data-act="shuffle">随机播放</button></div></div></div>';
      }
    }else{albumHead.innerHTML=''}
    var fl=visibleFiles();
    if(!fl.length){
      showEmpty(list.length?'没有匹配的音乐':'还没有音乐',list.length?'换个关键词试试':'点击右上角锁形按钮,登录后上传第一首');
      return;
    }
    emptyEl.style.display='none';
    listEl.innerHTML=fl.map(trackHtml).join('');
  }

  // 列表事件委托(播放/删除/编辑/排序/打开专辑)
  listEl.addEventListener('click',function(e){
    var al=e.target.closest('.album');
    if(al){albumOpen=al.getAttribute('data-album');qEl.value='';render();window.scrollTo(0,0);return}
    var tr=e.target.closest('.track');
    if(!tr)return;
    var name=tr.getAttribute('data-name');
    var mv=e.target.closest('[data-mv]');
    if(mv){moveItem(name,mv.getAttribute('data-mv'));return}
    if(reorderOn)return;
    if(e.target.closest('.del')){askDel(name)}
    else if(e.target.closest('.edit')){askEdit(name)}
    else{if(playing===name)toggle();else play(name,visibleNames())}
  });
  albumHead.addEventListener('click',function(e){
    var b=e.target.closest('[data-act]');if(!b)return;
    var act=b.getAttribute('data-act');
    if(act==='back'){albumOpen=null;qEl.value='';render();return}
    var names=sortFiles(list.filter(function(f){return (f.album||'')===albumOpen}),sortMode,order).map(function(f){return f.name});
    if(!names.length)return;
    if(act==='playall'){if(mode==='shuffle')setMode('loop',true);play(names[0],names)}
    else if(act==='shuffle'){setMode('shuffle',true);play(names[Math.floor(Math.random()*names.length)],names)}
  });
  qEl.addEventListener('input',render);
  $('qClear').addEventListener('click',function(){qEl.value='';render()});

  // 视图 / 排序
  vSongs.addEventListener('click',function(){view='songs';albumOpen=null;lsSet('r2m_view',view);render()});
  vAlbums.addEventListener('click',function(){view='albums';albumOpen=null;lsSet('r2m_view',view);render()});
  sortSel.addEventListener('change',function(){sortMode=sortSel.value;lsSet('r2m_sort',sortMode);render()});

  // ---------- 自定义顺序整理 ----------
  btnReorder.addEventListener('click',function(){
    if(view!=='songs')return;
    qEl.value='';
    workOrder=sortFiles(list,'custom',order).map(function(f){return f.name});
    reorderOn=true;render();
  });
  btnRCancel.addEventListener('click',function(){reorderOn=false;workOrder=[];render()});
  btnRSave.addEventListener('click',function(){
    api('PUT','/api/order',JSON.stringify({order:workOrder}),'application/json').then(function(){
      order=workOrder.slice();reorderOn=false;workOrder=[];
      sortMode='custom';lsSet('r2m_sort',sortMode);
      toast('顺序已保存');render();
    }).catch(function(e){toast('保存失败:'+e.message,1)});
  });
  function moveItem(name,how){
    var i=workOrder.indexOf(name);if(i<0)return;
    if(how==='top'){workOrder.splice(i,1);workOrder.unshift(name)}
    else if(how==='up'&&i>0){workOrder[i]=workOrder[i-1];workOrder[i-1]=name}
    else if(how==='down'&&i<workOrder.length-1){workOrder[i]=workOrder[i+1];workOrder[i+1]=name}
    renderTracks();
  }

  // ---------- 播放 ----------
  function applyNow(f){
    pName.textContent=f.title||f.name;
    curSub=[f.artist,f.album].filter(Boolean).join(' · ');
    pSub.textContent=pStatus;
    artEl.style.backgroundImage=f.cover?'url('+JSON.stringify(f.cover)+')':'';
    artEl.classList.toggle('hascv',!!f.cover);
    nowTitle.textContent=f.title||f.name;
    nowArtist.textContent=[f.artist||'未知歌手',f.album].filter(Boolean).join(' · ');
    $('nowAlbum').textContent=f.album||'黑胶唱片';
    nowCover.style.backgroundImage=f.cover?'url('+JSON.stringify(f.cover)+')':'';
    nowCover.classList.toggle('hascv',!!f.cover);
    setPlayerBackground();
    if('mediaSession' in navigator&&window.MediaMetadata){
      try{
        navigator.mediaSession.metadata=new MediaMetadata({
          title:f.title||f.name,artist:f.artist||'',album:f.album||'',
          artwork:f.cover?[{src:new URL(f.cover,location.href).href}]:[]
        });
      }catch(e){}
    }
  }
  // ctx: 播放队列(从哪个列表点的歌就用哪个列表);不传则沿用当前队列
  function play(name,ctx){
    var f=map[name];
    if(!f)return;
    if(ctx){queue=ctx.slice();hist=[];bag=[]}
    else if(queue.indexOf(name)<0){queue=visibleNames();hist=[];bag=[]}
    if(playing&&playing!==name&&isFinite(audio.duration))lastPos[playing]=audio.currentTime||0;
    playing=name;resumeAt=lastPos[name]||0;buffering=true;seekEditing=false;
    pStatus='正在缓冲…';render();
    audio.src='/api/file/'+encodeURIComponent(name);
    applyNow(f);syncProgress();syncPlayback();startAudio();
    if(queueEl.classList.contains('show'))renderQueue();
  }
  function startAudio(){
    if(!playing)return;
    var target=playing;playFailed=false;
    var p=audio.play();
    if(p&&p.catch)p.catch(function(e){
      if(target!==playing||(e&&e.name==='AbortError'))return;
      buffering=false;playFailed=true;pSub.textContent='播放失败,请点击重试';syncPlayback();
      toast(e&&e.name==='NotAllowedError'?'请再次点击歌曲开始播放':'音频无法播放,请检查文件',1);
    });
  }
  function qFiles(){return queue.map(function(n){return map[n]}).filter(Boolean)}
  function toggle(){
    if(!playing&&list.length){var v=visibleNames();if(v.length)play(v[0],v);return}
    if(audio.paused){startAudio()}else{audio.pause()}
  }
  function step(dir){
    var q=qFiles();
    if(!q.length)return;
    var i=-1;q.forEach(function(f,k){if(f.name===playing)i=k});
    if(mode==='shuffle'&&q.length>1){
      if(dir<0){
        while(hist.length){var p=hist.pop();if(map[p]&&p!==playing){play(p);return}}
      }
      var names=q.map(function(f){return f.name});
      bag=bag.filter(function(n){return n!==playing&&names.indexOf(n)>=0});
      if(!bag.length)bag=names.filter(function(n){return n!==playing});
      var pick=bag.splice(Math.floor(Math.random()*bag.length),1)[0];
      if(playing){hist.push(playing);if(hist.length>200)hist.shift()}
      play(pick);
      return;
    }
    play(q[i<0?0:(i+dir+q.length)%q.length].name);
  }
  audio.loop=(mode==='one');
  audio.addEventListener('loadedmetadata',function(){
    var f=map[playing];
    if(f){f.dur=audio.duration;if(!reorderOn)render()}
    if(resumeAt>3&&resumeAt<audio.duration-5){try{audio.currentTime=resumeAt}catch(e){}}
    resumeAt=0;syncProgress();
  });
  audio.addEventListener('durationchange',syncProgress);
  audio.addEventListener('timeupdate',syncProgress);
  audio.addEventListener('play',function(){if(playing)pSub.textContent=buffering?'缓冲中…':'播放中';syncPlayback()});
  audio.addEventListener('playing',function(){buffering=false;if(playing)pSub.textContent='播放中';syncPlayback()});
  audio.addEventListener('pause',function(){
    if(playing){pSub.textContent='已暂停';if(isFinite(audio.duration)&&audio.duration>0)lastPos[playing]=audio.currentTime||0}
    syncPlayback();
  });
  audio.addEventListener('ended',function(){if(playing)lastPos[playing]=0;syncPlayback();step(1)});
  audio.addEventListener('waiting',function(){buffering=true;if(playing)pSub.textContent='缓冲中…';syncPlayback()});
  audio.addEventListener('canplay',function(){if(playing&&!audio.paused){buffering=false;pSub.textContent='播放中'}syncPlayback()});
  audio.addEventListener('emptied',function(){buffering=true;syncProgress();syncPlayback()});
  audio.addEventListener('error',function(){
    buffering=false;playFailed=true;
    if(playing){pSub.textContent='加载失败';toast('音频加载失败',1)}syncPlayback();
  });
  pBar.addEventListener('click',function(e){
    var r=pBar.getBoundingClientRect();if(!r.width)return;
    var x=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
    if(isFinite(audio.duration)&&audio.duration>0){try{audio.currentTime=x*audio.duration}catch(err){}syncProgress()}
  });
  btnPlay.addEventListener('click',toggle);
  $('btnPrev').addEventListener('click',function(){step(-1)});
  $('btnNext').addEventListener('click',function(){step(1)});
  if('mediaSession' in navigator){
    try{
      navigator.mediaSession.setActionHandler('play',startAudio);
      navigator.mediaSession.setActionHandler('pause',function(){audio.pause()});
      navigator.mediaSession.setActionHandler('previoustrack',function(){step(-1)});
      navigator.mediaSession.setActionHandler('nexttrack',function(){step(1)});
    }catch(e){}
  }

  // 播放模式:顺序循环 → 随机播放 → 单曲循环
  function setMode(m,silent){
    mode=m;lsSet('r2m_mode',m);bag=[];
    audio.loop=(m==='one');
    btnMode.innerHTML=MODE_ICONS[m];
    btnMode.title=MODE_NAMES[m];
    btnMode.classList.toggle('on',m!=='loop');
    nowMode.innerHTML=MODE_ICONS[m];nowMode.title=MODE_NAMES[m];
    nowMode.setAttribute('aria-label',MODE_NAMES[m]+'，点击切换');
    nowMode.classList.toggle('active',m!=='loop');
    qModeEl.textContent=MODE_NAMES[m];
    if(!silent)toast(MODE_NAMES[m]);
  }
  btnMode.addEventListener('click',function(){
    setMode(mode==='loop'?'shuffle':(mode==='shuffle'?'one':'loop'));
  });
  setMode(mode,true);

  // 展开的播放列表
  function renderQueue(){
    var q=qFiles();
    qTitle.textContent='播放列表 · '+q.length+' 首';
    qModeEl.textContent=MODE_NAMES[mode];
    qList.innerHTML=q.map(function(f,i){
      var sub=[f.artist,f.album].filter(Boolean).join(' · ');
      return '<div class="qi'+(f.name===playing?' cur':'')+'" data-name="'+esc(f.name)+'">'
        +'<span class="qn">'+(f.name===playing?'▶':(i+1))+'</span>'
        +'<span class="qm"><div class="qt">'+esc(f.title||f.name)+'</div>'+(sub?'<div class="qs">'+esc(sub)+'</div>':'')+'</span></div>';
    }).join('')||'<div class="qempty">播放列表为空</div>';
    var cur=qList.querySelector('.cur');
    if(cur)qList.scrollTop=Math.max(0,cur.offsetTop-qList.clientHeight/2+cur.offsetHeight/2);
  }
  function toggleQueue(show){
    var on=show===undefined?!queueEl.classList.contains('show'):show;
    if(on&&!queue.length)queue=visibleNames();
    queueEl.classList.toggle('show',on);
    btnQueue.classList.toggle('on',on);nowQueue.classList.toggle('active',on);
    btnQueue.setAttribute('aria-expanded',String(on));nowQueue.setAttribute('aria-expanded',String(on));
    if(on)renderQueue();
  }
  btnQueue.addEventListener('click',function(){toggleQueue()});
  $('qClose').addEventListener('click',function(){toggleQueue(false)});
  qList.addEventListener('click',function(e){
    var it=e.target.closest('.qi');if(!it)return;
    play(it.getAttribute('data-name'));
  });

  // 全局快捷键(桌面)
  document.addEventListener('keydown',function(e){
    var t=e.target.tagName;
    if(e.code==='Escape'){
      if($('siteModal').classList.contains('show'))closeSite();
      else if(queueEl.classList.contains('show'))toggleQueue(false);
      else closeNow();
      return;
    }
    if(t==='INPUT'||t==='SELECT'||t==='TEXTAREA'||document.querySelector('.modal.show'))return;
    if(e.code==='Space'&&t!=='BUTTON'){e.preventDefault();toggle()}
    if(e.code==='ArrowRight')step(1);
    if(e.code==='ArrowLeft')step(-1);
  });

  // ---------- 管理(上传/删除) ----------
  var adminOn=!!token;
  function setAdmin(){
    document.body.classList.toggle('admin',adminOn);
    if(adminOn){upStrip.classList.add('show')}
    else{upStrip.classList.remove('show')}
  }
  function askLogin(){var m=$('loginModal');m.classList.add('show');setTimeout(function(){$('tok').focus()},50)}
  function doLogin(){
    var v=$('tok').value.trim();if(!v)return;
    // 用一次需要鉴权的请求验证令牌
    fetch('/api/verify',{method:'POST',headers:{'Authorization':'Bearer '+v}}).then(function(r){
      if(r.ok){token=v;adminOn=true;try{sessionStorage.setItem('r2m_token',token)}catch(e){}setAdmin();toast('已登录,可以上传/删除/编辑');load();}
      else{toast('令牌不正确',1)}
      $('loginModal').classList.remove('show');$('tok').value='';
    }).catch(function(){toast('网络错误',1)});
  }
  $('btnAdmin').addEventListener('click',function(){adminOn?setAdmin():askLogin()});
  $('btnLoginOk').addEventListener('click',doLogin);
  $('btnLoginNo').addEventListener('click',function(){$('loginModal').classList.remove('show')});
  $('tok').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin()});

  // 上传
  function uploadFiles(files){
    if(!files.length)return;
    var idx=0,ok=0,fail=0,errMsg='';
    upStrip.querySelector('.u-txt').style.display='none';
    var prog=upStrip.querySelector('.u-progress');prog.style.display='block';
    (function next(){
      if(idx>=files.length){
        setTimeout(function(){
          prog.style.display='none';upStrip.querySelector('.u-txt').style.display='';
          toast(ok?'上传完成 '+ok+' 首'+(fail?' · '+fail+' 失败':''):('上传失败 '+(errMsg||'请重试')),fail&&!ok?1:0);
          if(ok){load()}
        },300);
        return;
      }
      var f=files[idx++];var xhr=new XMLHttpRequest();
      xhr.open('POST','/api/upload?name='+encodeURIComponent(f.name),true);
      xhr.setRequestHeader('Authorization','Bearer '+token);
      xhr.upload.onprogress=function(e){if(e.lengthComputable){prog.firstElementChild.style.width=(e.loaded/e.total*100)+'%'}};
      xhr.onload=function(){
        if(xhr.status===200){ok++}
        else{fail++;try{errMsg=JSON.parse(xhr.responseText).error||xhr.statusText}catch(e){errMsg=xhr.statusText}}
        next();
      };
      xhr.onerror=function(){fail++;errMsg='网络错误';next()};
      xhr.send(f);
    })();
  }
  upStrip.addEventListener('click',function(){upInput.click()});
  upInput.addEventListener('change',function(){uploadFiles(Array.prototype.slice.call(upInput.files));upInput.value=''});
  // 拖拽上传
  ['dragenter','dragover'].forEach(function(ev){document.addEventListener(ev,function(e){e.preventDefault();if(adminOn)upStrip.classList.add('drag')})});
  ['dragleave','drop'].forEach(function(ev){document.addEventListener(ev,function(e){e.preventDefault();upStrip.classList.remove('drag')})});
  document.addEventListener('drop',function(e){
    if(!adminOn||!e.dataTransfer)return;
    var files=[];for(var i=0;i<e.dataTransfer.files.length;i++)files.push(e.dataTransfer.files[i]);
    if(files.length)uploadFiles(files);
  });

  // 删除
  var delTarget=null;
  function askDel(name){delTarget=name;$('delName').textContent=name;$('delModal').classList.add('show')}
  $('btnDelOk').addEventListener('click',function(){
    if(!delTarget)return;
    var target=delTarget;
    fetch('/api/file/'+encodeURIComponent(target),{method:'DELETE',headers:{'Authorization':'Bearer '+token}}).then(function(r){
      $('delModal').classList.remove('show');
      if(r.ok){
        if(playing===target)stopPlayback();
        toast('已删除');load();
      }else{toast('删除失败',1)}
    });
  });
  $('btnDelNo').addEventListener('click',function(){$('delModal').classList.remove('show')});

  // 编辑元数据(歌名/作者/专辑/封面)
  var editTarget=null, pendingCover=null, removeCover=false, cvBox=$('cvBox'), cvInput=$('cvInput');
  function api(method,url,body,ct){
    var h={'Authorization':'Bearer '+token};if(ct)h['Content-Type']=ct;
    return fetch(url,{method:method,headers:h,body:body}).then(function(r){
      if(r.ok)return r;
      return r.json().catch(function(){return{}}).then(function(j){throw new Error(j.error||('HTTP '+r.status))});
    });
  }
  function showCover(url){
    if(url){cvBox.style.backgroundImage='url('+JSON.stringify(url)+')';cvBox.classList.add('has')}
    else{cvBox.style.backgroundImage='';cvBox.classList.remove('has')}
  }
  // 封面压缩到最长边 600px 的 JPEG,节省流量
  function shrink(file,cb){
    var img=new Image(),u=URL.createObjectURL(file);
    img.onload=function(){
      var s=Math.min(1,600/Math.max(img.width,img.height)),c=document.createElement('canvas');
      c.width=Math.max(1,Math.round(img.width*s));c.height=Math.max(1,Math.round(img.height*s));
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(u);
      c.toBlob(function(b){cb(b||file)},'image/jpeg',0.88);
    };
    img.onerror=function(){URL.revokeObjectURL(u);cb(file)};
    img.src=u;
  }
  function fillDatalist(id,key){
    var seen={},html='';
    list.forEach(function(f){var v=f[key];if(v&&!seen[v]){seen[v]=1;html+='<option value="'+esc(v)+'"></option>'}});
    $(id).innerHTML=html;
  }
  function askEdit(name){
    var f=map[name];if(!f)return;
    editTarget=name;pendingCover=null;removeCover=false;
    $('editFile').textContent=name;
    $('eTitle').value=f.title||'';
    $('eArtist').value=f.artist||'';
    $('eAlbum').value=f.album||'';
    fillDatalist('artistList','artist');fillDatalist('albumList','album');
    showCover(f.cover);
    $('editModal').classList.add('show');
  }
  cvBox.addEventListener('click',function(){cvInput.click()});
  $('cvPick').addEventListener('click',function(){cvInput.click()});
  $('cvClear').addEventListener('click',function(){pendingCover=null;removeCover=true;showCover('')});
  cvInput.addEventListener('change',function(){
    var file=cvInput.files[0];cvInput.value='';
    if(!file)return;
    if(file.type.indexOf('image/')!==0){toast('请选择图片文件',1);return}
    shrink(file,function(b){
      if(b.size>5*1024*1024){toast('封面过大(>5MB)',1);return}
      pendingCover=b;removeCover=false;showCover(URL.createObjectURL(b));
    });
  });
  $('btnEditNo').addEventListener('click',function(){$('editModal').classList.remove('show')});
  $('btnEditOk').addEventListener('click',function(){
    if(!editTarget)return;
    var enc=encodeURIComponent(editTarget);
    var meta=JSON.stringify({title:$('eTitle').value,artist:$('eArtist').value,album:$('eAlbum').value});
    api('PUT','/api/meta/'+enc,meta,'application/json').then(function(){
      if(pendingCover)return api('POST','/api/cover/'+enc,pendingCover,pendingCover.type||'image/jpeg');
      if(removeCover)return api('DELETE','/api/cover/'+enc);
    }).then(function(){
      $('editModal').classList.remove('show');
      toast('已保存');load();
    }).catch(function(e){toast('保存失败:'+e.message,1)});
  });

  // ---------- 主题(深色 / 浅色) ----------
  var THEME_ICONS={
    // 深色时显示太阳(点击切到浅色),浅色时显示月亮
    light:SVG_A+'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
    dark:SVG_A+'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
  };
  var btnTheme=$('btnTheme');
  function currentTheme(){return document.documentElement.getAttribute('data-theme')==='light'?'light':'dark'}
  function applyTheme(t,save){
    document.documentElement.setAttribute('data-theme',t);
    var m=document.querySelector('meta[name="theme-color"]');
    if(m)m.setAttribute('content',t==='light'?'#f3f4f7':'#08090d');
    btnTheme.innerHTML=t==='light'?THEME_ICONS.dark:THEME_ICONS.light;
    btnTheme.title=t==='light'?'切换到深色主题':'切换到浅色主题';
    if(save)lsSet('r2m_theme',t);
  }
  btnTheme.addEventListener('click',function(){applyTheme(currentTheme()==='light'?'dark':'light',true)});
  applyTheme(currentTheme(),false);
  // 没手动选择过时,跟随系统主题变化
  try{
    var mq=window.matchMedia('(prefers-color-scheme: light)');
    var onMq=function(e){if(!lsGet('r2m_theme',''))applyTheme(e.matches?'light':'dark',false)};
    if(mq.addEventListener)mq.addEventListener('change',onMq);
  }catch(e){}

  // ---------- 站点设置(名称 / Logo / 播放背景) ----------
  var pendingLogo=null, removeLogo=false, sLogoBox=$('sLogoBox'), sInput=$('sInput');
  var pendingBackground=null, removeBackground=false, sBgBox=$('sBgBox'), sBgInput=$('sBgInput');
  var bgPreviewUrl='', logoPreviewUrl='', bgRevision=0, logoRevision=0;
  var backgroundLoading=false, logoLoading=false, siteSaving=false, siteLoadId=0;
  function syncSiteButton(){
    $('btnSiteOk').disabled=siteSaving||backgroundLoading||logoLoading;
    $('btnSiteOk').textContent=siteSaving?'保存中…':((backgroundLoading||logoLoading)?'处理图片中…':'保存');
  }
  function showBackground(url){
    sBgBox.style.backgroundImage=url?'url('+JSON.stringify(url)+')':'';
    sBgBox.classList.toggle('has',!!url);
    $('sBgHint').textContent=url?'保存后应用到黑胶播放页,所有设备共用':'不设置时,自动用当前歌曲封面作为模糊背景';
  }
  function releaseSitePreviews(){
    if(bgPreviewUrl)URL.revokeObjectURL(bgPreviewUrl);
    if(logoPreviewUrl)URL.revokeObjectURL(logoPreviewUrl);
    bgPreviewUrl=logoPreviewUrl='';
  }
  function closeSite(){
    if(siteSaving)return;
    siteLoadId++;bgRevision++;logoRevision++;backgroundLoading=logoLoading=false;
    $('siteModal').classList.remove('show');releaseSitePreviews();syncSiteButton();
    if(nowOpen){try{$('nowBackground').focus({preventScroll:true})}catch(e){}}
  }
  // 背景保留原图比例,不裁成封面方图;最长边 2048px,GIF 保留动画
  function prepareBackground(file){
    if(['image/jpeg','image/png','image/webp','image/gif'].indexOf(file.type)<0)return Promise.reject(new Error('仅支持 JPG / PNG / WebP / GIF'));
    if(file.type==='image/gif')return file.size<=5*1024*1024?Promise.resolve(file):Promise.reject(new Error('GIF 超过 5MB'));
    if(file.size>30*1024*1024)return Promise.reject(new Error('原图超过 30MB,请先缩小图片'));
    return new Promise(function(resolve,reject){
      var img=new Image(),u=URL.createObjectURL(file);
      img.onload=function(){
        try{
          var s=Math.min(1,2048/Math.max(img.width,img.height)),c=document.createElement('canvas');
          c.width=Math.max(1,Math.round(img.width*s));c.height=Math.max(1,Math.round(img.height*s));
          var ctx=c.getContext('2d');ctx.fillStyle='#090a0d';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(img,0,0,c.width,c.height);
          URL.revokeObjectURL(u);
          c.toBlob(function(b){if(!b||b.size>5*1024*1024)reject(new Error('图片压缩失败或仍超过 5MB'));else resolve(b)},'image/jpeg',.9);
        }catch(e){URL.revokeObjectURL(u);reject(new Error('无法处理这张图片'))}
      };
      img.onerror=function(){URL.revokeObjectURL(u);reject(new Error('图片无法读取,请更换图片'))};
      img.src=u;
    });
  }
  function setFavicons(url){
    var old=document.querySelectorAll('link[rel="icon"],link[rel="apple-touch-icon"]');
    for(var i=0;i<old.length;i++)old[i].parentNode.removeChild(old[i]);
    var a=document.createElement('link');a.rel='icon';a.href=url||'/favicon.svg';document.head.appendChild(a);
    if(url){var b=document.createElement('link');b.rel='apple-touch-icon';b.href=url;document.head.appendChild(b)}
  }
  function applySite(s){
    var name=s.name||s.defaultName;
    $('siteName').textContent=name;
    $('siteSub').textContent=s.sub||s.defaultSub;
    document.title=name+' · 在线播放器';
    var lg=$('siteLogo');
    if(s.logoUrl){lg.className='logo custom';lg.innerHTML='<img alt="" src="'+esc(s.logoUrl)+'">'}
    else{lg.className='logo';lg.innerHTML=NOTE.replace('stroke-width="1.6"','stroke-width="2"')}
    setFavicons(s.logoUrl);
    siteBackground=s.backgroundUrl||'';setPlayerBackground();
  }
  function showLogo(url){
    if(url){sLogoBox.style.backgroundImage='url('+JSON.stringify(url)+')';sLogoBox.classList.add('has')}
    else{sLogoBox.style.backgroundImage='';sLogoBox.classList.remove('has')}
  }
  // Logo 居中裁成正方形,缩到 256px 的 PNG(保留透明背景)
  function squareLogo(file,cb){
    var img=new Image(),u=URL.createObjectURL(file);
    img.onload=function(){
      var S=256,c=document.createElement('canvas');c.width=S;c.height=S;
      var side=Math.min(img.width,img.height),sx=(img.width-side)/2,sy=(img.height-side)/2;
      c.getContext('2d').drawImage(img,sx,sy,side,side,0,0,S,S);URL.revokeObjectURL(u);
      c.toBlob(function(b){cb(b||file)},'image/png');
    };
    img.onerror=function(){URL.revokeObjectURL(u);cb(file)};
    img.src=u;
  }
  function openSite(){
    if(siteSaving||!adminOn)return;
    var id=++siteLoadId;
    fetch('/api/site').then(function(r){if(!r.ok)throw new Error('站点设置读取失败');return r.json()}).then(function(s){
      if(id!==siteLoadId)return;
      bgRevision++;logoRevision++;releaseSitePreviews();
      pendingLogo=pendingBackground=null;removeLogo=removeBackground=false;backgroundLoading=logoLoading=false;
      $('sName').value=s.name||'';$('sSub').value=s.sub||'';
      $('sName').placeholder=s.defaultName;$('sSub').placeholder=s.defaultSub;
      showLogo(s.logoUrl);showBackground(s.backgroundUrl);syncSiteButton();
      $('siteModal').classList.add('show');
    }).catch(function(e){if(id===siteLoadId)toast('加载失败:'+e.message,1)});
  }
  $('btnSite').addEventListener('click',openSite);
  sLogoBox.addEventListener('click',function(){if(!siteSaving)sInput.click()});
  $('sPick').addEventListener('click',function(){if(!siteSaving)sInput.click()});
  $('sClear').addEventListener('click',function(){
    if(siteSaving)return;logoRevision++;logoLoading=false;pendingLogo=null;removeLogo=true;
    if(logoPreviewUrl)URL.revokeObjectURL(logoPreviewUrl);logoPreviewUrl='';showLogo('');syncSiteButton();
  });
  sInput.addEventListener('change',function(){
    var file=sInput.files[0];sInput.value='';
    if(!file||siteSaving)return;
    if(file.type.indexOf('image/')!==0){toast('请选择图片文件',1);return}
    var id=++logoRevision;logoLoading=true;syncSiteButton();
    squareLogo(file,function(b){
      if(id!==logoRevision)return;
      logoLoading=false;syncSiteButton();
      if(b.size>2*1024*1024){toast('Logo 超过 2MB',1);return}
      pendingLogo=b;removeLogo=false;
      if(logoPreviewUrl)URL.revokeObjectURL(logoPreviewUrl);logoPreviewUrl=URL.createObjectURL(b);showLogo(logoPreviewUrl);
    });
  });
  function pickBackground(){if(!siteSaving)sBgInput.click()}
  sBgBox.addEventListener('click',pickBackground);$('sBgPick').addEventListener('click',pickBackground);
  sBgBox.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();pickBackground()}});
  $('sBgClear').addEventListener('click',function(){
    if(siteSaving)return;bgRevision++;backgroundLoading=false;pendingBackground=null;removeBackground=true;
    if(bgPreviewUrl)URL.revokeObjectURL(bgPreviewUrl);bgPreviewUrl='';showBackground('');syncSiteButton();
  });
  sBgInput.addEventListener('change',function(){
    var file=sBgInput.files[0];sBgInput.value='';if(!file||siteSaving)return;
    var id=++bgRevision;backgroundLoading=true;syncSiteButton();
    prepareBackground(file).then(function(b){
      if(id!==bgRevision)return;
      pendingBackground=b;removeBackground=false;
      if(bgPreviewUrl)URL.revokeObjectURL(bgPreviewUrl);bgPreviewUrl=URL.createObjectURL(b);showBackground(bgPreviewUrl);
    }).catch(function(e){if(id===bgRevision)toast(e.message,1)}).then(function(){
      if(id===bgRevision){backgroundLoading=false;syncSiteButton()}
    });
  });
  $('btnSiteNo').addEventListener('click',closeSite);
  $('btnSiteOk').addEventListener('click',function(){
    if(siteSaving||backgroundLoading||logoLoading)return;
    siteSaving=true;syncSiteButton();
    var fields=$('siteModal').querySelectorAll('input,button');
    Array.prototype.forEach.call(fields,function(el){el.disabled=true});
    var body=JSON.stringify({name:$('sName').value,sub:$('sSub').value});
    api('PUT','/api/site',body,'application/json').then(function(r){return r.json()}).then(function(s){
      if(pendingLogo)return api('POST','/api/site/logo',pendingLogo,pendingLogo.type||'image/png').then(function(r){return r.json()});
      if(removeLogo)return api('DELETE','/api/site/logo').then(function(r){return r.json()});
      return s;
    }).then(function(s){
      if(pendingBackground)return api('POST','/api/site/background',pendingBackground,pendingBackground.type||'image/jpeg').then(function(r){return r.json()});
      if(removeBackground)return api('DELETE','/api/site/background').then(function(r){return r.json()});
      return s;
    }).then(function(s){
      applySite(s);siteSaving=false;closeSite();toast('站点设置已保存');
    }).catch(function(e){toast('保存失败:'+e.message,1)}).then(function(){
      siteSaving=false;Array.prototype.forEach.call(fields,function(el){el.disabled=false});syncSiteButton();
    });
  });

  // ---------- 禁止缩放 / 长按 / 拖拽(输入框除外) ----------
  // iOS Safari 会忽略 user-scalable=no,需要拦截 gesture 事件;双击放大由 CSS touch-action 处理
  ['gesturestart','gesturechange','gestureend'].forEach(function(ev){
    document.addEventListener(ev,function(e){e.preventDefault()},{passive:false});
  });
  document.addEventListener('touchmove',function(e){if(e.touches&&e.touches.length>1)e.preventDefault()},{passive:false});
  document.addEventListener('wheel',function(e){if(e.ctrlKey)e.preventDefault()},{passive:false});
  document.addEventListener('keydown',function(e){
    if((e.ctrlKey||e.metaKey)&&['+','-','=','_','0'].indexOf(e.key)>=0)e.preventDefault();
  });
  document.addEventListener('contextmenu',function(e){
    var t=e.target&&e.target.tagName;
    if(t!=='INPUT'&&t!=='TEXTAREA')e.preventDefault();
  });
  document.addEventListener('dragstart',function(e){e.preventDefault()});

  setAdmin();syncPlayback();syncProgress();
  load();
  window.__r2m={play:play,askDel:askDel,openPlayer:openNow,closePlayer:closeNow};
})();
</script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const bucket = env.MUSIC_BUCKET;

    try {
      // 页面
      if (request.method === 'GET' && path === '/') {
        return new Response(renderPage(await readSite(bucket)), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }

      // 网页图标:有自定义 Logo 用 Logo,否则用默认图标
      if (request.method === 'GET' && (path === '/favicon.svg' || path === '/favicon.ico')) {
        if (path === '/favicon.ico') {
          const site = await readSite(bucket);
          if (site.logo) {
            const res = await serveLogo(bucket, { 'cache-control': 'public, max-age=3600' });
            if (res) return res;
          }
        }
        return new Response(DEFAULT_FAVICON_SVG, {
          headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' },
        });
      }

      // 站点设置
      if (path === '/api/site' && request.method === 'GET') {
        return jsonRes(siteView(await readSite(bucket)));
      }
      if (path === '/api/site' && request.method === 'PUT') {
        if (!authorized(request, env)) return jsonRes({ error: '需要管理令牌' }, 401);
        let body;
        try { body = await request.json(); } catch (e) { return jsonRes({ error: '请求体不是有效 JSON' }, 400); }
        const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
        const site = await readSite(bucket);
        const name = clean(body && body.name, 30);
        const sub = clean(body && body.sub, 60);
        if (name) site.name = name; else delete site.name;
        if (sub) site.sub = sub; else delete site.sub;
        await writeSite(bucket, site);
        return jsonRes(siteView(site));
      }
      if (path === '/api/site/logo' && request.method === 'GET') {
        const res = await serveLogo(bucket, { 'cache-control': 'private, max-age=31536000, immutable' });
        return res || new Response('Not Found', { status: 404 });
      }
      if (path === '/api/site/logo' && request.method === 'POST') {
        if (!authorized(request, env)) return jsonRes({ error: '需要管理令牌' }, 401);
        const ct = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!COVER_TYPES.includes(ct)) return jsonRes({ error: 'Logo 仅支持 jpg/png/webp/gif' }, 400);
        const len = Number(request.headers.get('content-length') || 0);
        if (len > LOGO_MAX_BYTES) return jsonRes({ error: 'Logo 超过 2MB 上限' }, 413);
        await bucket.put(LOGO_KEY, request.body, { httpMetadata: { contentType: ct } });
        const site = await readSite(bucket);
        site.logo = Date.now();
        await writeSite(bucket, site);
        return jsonRes(siteView(site));
      }
      if (path === '/api/site/logo' && request.method === 'DELETE') {
        if (!authorized(request, env)) return jsonRes({ error: '需要管理令牌' }, 401);
        await bucket.delete(LOGO_KEY);
        const site = await readSite(bucket);
        delete site.logo;
        await writeSite(bucket, site);
        return jsonRes(siteView(site));
      }

      // 全屏播放页自定义背景(读取公开,写入/删除沿用管理令牌)
      if (path === '/api/site/background' && request.method === 'GET') {
        const obj = await bucket.get(BACKGROUND_KEY);
        if (!obj) return new Response('Not Found', { status: 404, headers: { 'cache-control': 'no-store' } });
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set('etag', obj.httpEtag);
        if (!headers.has('content-type')) headers.set('content-type', 'image/jpeg');
        // 带非空版本号的 URL 可长期缓存;无版本号时禁止缓存,避免上传/删除后仍显示旧图
        headers.set('cache-control', url.searchParams.get('v') ? 'public, max-age=31536000, immutable' : 'no-store');
        return new Response(obj.body, { status: 200, headers });
      }
      if (path === '/api/site/background' && request.method === 'POST') {
        if (!authorized(request, env)) return jsonRes({ error: '需要管理令牌' }, 401);
        const ct = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!COVER_TYPES.includes(ct)) return jsonRes({ error: '背景仅支持 jpg/png/webp/gif' }, 400);
        const len = Number(request.headers.get('content-length') || 0);
        if (len > BACKGROUND_MAX_BYTES) {
          if (request.body) await request.body.cancel().catch(() => {});
          return jsonRes({ error: '背景超过 5MB 上限' }, 413);
        }
        const bytes = await readLimitedBody(request.body, BACKGROUND_MAX_BYTES);
        if (!bytes) return jsonRes({ error: '背景超过 5MB 上限' }, 413);
        if (!bytes.byteLength) return jsonRes({ error: '背景图片不能为空' }, 400);
        await bucket.put(BACKGROUND_KEY, bytes, { httpMetadata: { contentType: ct } });
        const site = await readSite(bucket);
        const previous = Number(site.background);
        site.background = Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0);
        await writeSite(bucket, site);
        return jsonRes(siteView(site));
      }
      if (path === '/api/site/background' && request.method === 'DELETE') {
        if (!authorized(request, env)) return jsonRes({ error: '需要管理令牌' }, 401);
        await bucket.delete(BACKGROUND_KEY);
        const site = await readSite(bucket);
        delete site.background;
        await writeSite(bucket, site);
        return jsonRes(siteView(site));
      }

      // 验证令牌(供前端登录确认)
      if (request.method === 'POST' && path === '/api/verify') {
        return new Response('{}', { status: authorized(request, env) ? 200 : 401, headers: { 'content-type': 'application/json' } });
      }

      // 文件列表
      if (request.method === 'GET' && path === '/api/list') {
        const objects = [];
        let cursor;
        do {
          const page = await bucket.list({ limit: 1000, cursor });
          objects.push(...page.objects);
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        const [idx, order] = await Promise.all([readIndex(bucket), readOrder(bucket)]);
        const files = objects
          .filter((o) => isAudio(o.key))
          .map((o) => {
            const m = idx[o.key] || {};
            return {
              name: o.key, size: o.size, uploaded: o.uploaded,
              title: m.title || '', artist: m.artist || '', album: m.album || '',
              cover: m.cv ? '/api/cover/' + encodeURIComponent(o.key) + '?v=' + m.cv : '',
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        return new Response(JSON.stringify({ files, order, version: VERSION }), {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }

      // 保存自定义顺序(PUT /api/order,JSON: {order: [文件名...]})
      if (request.method === 'PUT' && path === '/api/order') {
        if (!authorized(request, env)) return jsonRes({ error: '需要管理令牌' }, 401);
        let body;
        try { body = await request.json(); } catch (e) { return jsonRes({ error: '请求体不是有效 JSON' }, 400); }
        if (!body || !Array.isArray(body.order) || body.order.length > 20000) return jsonRes({ error: '参数无效' }, 400);
        const seen = new Set();
        const order = [];
        for (const n of body.order) {
          if (typeof n === 'string' && isAudio(n) && !seen.has(n)) { seen.add(n); order.push(n); }
        }
        await bucket.put(ORDER_KEY, JSON.stringify(order), { httpMetadata: { contentType: 'application/json' } });
        return jsonRes({ ok: true, count: order.length });
      }

      // 读取封面(公开)
      if (request.method === 'GET' && path.startsWith('/api/cover/')) {
        const name = nameFrom(path, '/api/cover/');
        if (!name || !isAudio(name)) return new Response('Not Found', { status: 404 });
        const obj = await bucket.get(coverKey(name));
        if (!obj) return new Response('Not Found', { status: 404 });
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set('etag', obj.httpEtag);
        if (!headers.has('content-type')) headers.set('content-type', 'image/jpeg');
        // URL 带 ?v=版本号,换封面后 URL 会变,可放心长期缓存
        headers.set('cache-control', 'private, max-age=31536000, immutable');
        return new Response(obj.body, { status: 200, headers });
      }

      // 保存歌名/作者/专辑(PUT /api/meta/<name>,JSON: {title, artist, album})
      if (request.method === 'PUT' && path.startsWith('/api/meta/')) {
        if (!authorized(request, env)) return jsonRes({ error: '需要管理令牌' }, 401);
        const name = nameFrom(path, '/api/meta/');
        if (!name || !isAudio(name)) return jsonRes({ error: '文件名无效' }, 400);
        if (!(await bucket.head(name))) return jsonRes({ error: '文件不存在' }, 404);
        let body;
        try { body = await request.json(); } catch (e) { return jsonRes({ error: '请求体不是有效 JSON' }, 400); }
        const clean = (s) => String(s == null ? '' : s).trim().slice(0, 200);
        const idx = await readIndex(bucket);
        const next = {};
        for (const k of ['title', 'artist', 'album']) { const v = clean(body && body[k]); if (v) next[k] = v; }
        if (idx[name] && idx[name].cv) next.cv = idx[name].cv;
        if (Object.keys(next).length) idx[name] = next; else delete idx[name];
        await writeIndex(bucket, idx);
        return jsonRes({ ok: true });
      }

      // 上传封面(POST /api/cover/<name>,body 为图片二进制)
      if (request.method === 'POST' && path.startsWith('/api/cover/')) {
        if (!authorized(request, env)) return jsonRes({ error: '需要管理令牌' }, 401);
        const name = nameFrom(path, '/api/cover/');
        if (!name || !isAudio(name)) return jsonRes({ error: '文件名无效' }, 400);
        if (!(await bucket.head(name))) return jsonRes({ error: '文件不存在' }, 404);
        const ct = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!COVER_TYPES.includes(ct)) return jsonRes({ error: '封面仅支持 jpg/png/webp/gif' }, 400);
        const len = Number(request.headers.get('content-length') || 0);
        if (len > COVER_MAX_BYTES) return jsonRes({ error: '封面超过 5MB 上限' }, 413);
        await bucket.put(coverKey(name), request.body, { httpMetadata: { contentType: ct } });
        const idx = await readIndex(bucket);
        idx[name] = Object.assign({}, idx[name], { cv: Date.now() });
        await writeIndex(bucket, idx);
        return jsonRes({ ok: true });
      }

      // 删除封面(DELETE /api/cover/<name>)
      if (request.method === 'DELETE' && path.startsWith('/api/cover/')) {
        if (!authorized(request, env)) return jsonRes({ error: '需要管理令牌' }, 401);
        const name = nameFrom(path, '/api/cover/');
        if (!name || !isAudio(name)) return jsonRes({ error: '文件名无效' }, 400);
        await bucket.delete(coverKey(name));
        const idx = await readIndex(bucket);
        if (idx[name]) {
          delete idx[name].cv;
          if (!Object.keys(idx[name]).length) delete idx[name];
          await writeIndex(bucket, idx);
        }
        return jsonRes({ ok: true });
      }

      // 上传(POST /api/upload?name=xxx)
      if (request.method === 'POST' && path === '/api/upload') {
        if (!authorized(request, env)) return new Response(JSON.stringify({ error: '需要管理令牌' }), { status: 401, headers: { 'content-type': 'application/json' } });
        const name = safeKey(url.searchParams.get('name') || '');
        if (name && !isAudio(name)) return new Response(JSON.stringify({ error: '仅支持音频文件' }), { status: 400, headers: { 'content-type': 'application/json' } });
        if (!name) return new Response(JSON.stringify({ error: '文件名无效' }), { status: 400, headers: { 'content-type': 'application/json' } });
        const len = Number(request.headers.get('content-length') || 0);
        if (len > MAX_UPLOAD_BYTES) return new Response(JSON.stringify({ error: '文件超过 50MB 上限' }), { status: 413, headers: { 'content-type': 'application/json' } });
        await bucket.put(name, request.body, { httpMetadata: { contentType: contentTypeFor(name) } });
        return new Response(JSON.stringify({ ok: true, name }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      // 播放 / 下载(GET /api/file/<name>,支持 Range)
      if (request.method === 'GET' && path.startsWith('/api/file/')) {
        let raw = path.slice('/api/file/'.length);
        let name;
        try { name = safeKey(decodeURIComponent(raw)); } catch (e) { name = safeKey(raw); }
        if (!name || !isAudio(name)) return new Response('Not Found', { status: 404 });
        const head = await bucket.head(name);
        if (!head) return new Response('Not Found', { status: 404 });
        const size = head.size;

        const headers = new Headers();
        head.writeHttpMetadata(headers);
        headers.set('etag', head.httpEtag);
        headers.set('accept-ranges', 'bytes');
        headers.set('cache-control', 'private, max-age=86400');
        // 统一使用按扩展名推断的音频类型,避免 octet-stream 导致浏览器不播放
        headers.set('content-type', contentTypeFor(name));

        // 解析 Range: bytes=start-end | bytes=start- | bytes=-suffix
        const rangeHeader = request.headers.get('Range');
        const m = rangeHeader && rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);
        if (m && (m[1] !== '' || m[2] !== '')) {
          let start, end;
          if (m[1] === '') {                       // 后缀区间:最后 N 字节
            const suffix = Math.min(Number(m[2]), size);
            start = size - suffix;
            end = size - 1;
          } else {
            start = Number(m[1]);
            end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
          }
          if (size === 0 || start >= size || start > end) {
            return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + size } });
          }
          const length = end - start + 1;
          const object = await bucket.get(name, { range: { offset: start, length } });
          if (!object) return new Response('Not Found', { status: 404 });
          headers.set('content-range', 'bytes ' + start + '-' + end + '/' + size);
          headers.set('content-length', String(length));
          return new Response(object.body, { status: 206, headers });
        }

        const object = await bucket.get(name);
        if (!object) return new Response('Not Found', { status: 404 });
        headers.set('content-length', String(size));
        return new Response(object.body, { status: 200, headers });
      }

      // 删除(DELETE /api/file/<name>)
      if (request.method === 'DELETE' && path.startsWith('/api/file/')) {
        if (!authorized(request, env)) return new Response(JSON.stringify({ error: '需要管理令牌' }), { status: 401, headers: { 'content-type': 'application/json' } });
        let raw = path.slice('/api/file/'.length);
        let name;
        try { name = safeKey(decodeURIComponent(raw)); } catch (e) { name = safeKey(raw); }
        if (!name) return new Response(JSON.stringify({ error: '文件名无效' }), { status: 400, headers: { 'content-type': 'application/json' } });
        if (!isAudio(name)) return new Response(JSON.stringify({ error: '文件名无效' }), { status: 400, headers: { 'content-type': 'application/json' } });
        await bucket.delete(name);
        // 同步清理封面和元数据
        await bucket.delete(coverKey(name));
        const idx = await readIndex(bucket);
        if (idx[name]) { delete idx[name]; await writeIndex(bucket, idx); }
        const ord = await readOrder(bucket);
        if (ord.includes(name)) {
          await bucket.put(ORDER_KEY, JSON.stringify(ord.filter((n) => n !== name)), { httpMetadata: { contentType: 'application/json' } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
  },
};
