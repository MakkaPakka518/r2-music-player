/**
 * R2 Music Player — 配合 Cloudflare R2 的在线小型播放器
 * 单文件 Worker:粘贴到 Cloudflare Dashboard 即可部署
 *
 * 版本:2.0.0
 * 新增:仅播放时显示底栏;封面进入黑胶播放页;播放旋转/暂停停转;R2 自定义背景
 * 背景设置:管理员 → 站点设置 → 黑胶播放页背景,保存后所有设备共用
 * 绑定:R2 bucket 命名为 MUSIC_BUCKET(在 Worker 设置 → 绑定 → R2 中添加)
 * 可选环境变量:AUTH_TOKEN(配置后上传/删除需要令牌;留空则公开可传)
 *
 * 功能:
 *  - 文件列表(自动识别音频)
 *  - 在线播放(支持 Range 拖动进度条)
 *  - 上传 mp3/m4a/flac/ogg/wav/aac(可选令牌保护)
 *  - 删除文件(可选令牌保护)
 *  - 收藏/歌单/播放记忆/最近播放(当前设备),歌词/外观/专辑背景(R2)
 *  - 音频信息提取、批量管理、睡眠定时、桌面应用
 */

const VERSION = '2.0.0';

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
    : '<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/app-icon-192.png">';
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
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
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

  <div id="plusToolbar" aria-label="音乐功能"></div>
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
      <div id="nowExtras" aria-label="播放扩展功能"></div>
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
  function plusEvent(name,detail){document.dispatchEvent(new CustomEvent("r2:"+name,{detail:detail}))}
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
    plusEvent('background');
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
      map=Object.create(null);list.forEach(function(f){map[f.name]=f});
      plusEvent('loaded');
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

  function showEmpty(t1,t2){listEl.innerHTML='';emptyEl.style.display='block';emptyT1.textContent=t1;emptyT2.textContent=t2;plusEvent('render')}

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
    plusEvent('render');
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
    plusEvent('render');
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
  var baseApplyNow=applyNow;applyNow=function(f){baseApplyNow(f);plusEvent('track',f)};
  // ctx: 播放队列(从哪个列表点的歌就用哪个列表);不传则沿用当前队列
  function play(name,ctx){
    var f=map[name];
    if(!f)return;
    if(ctx){queue=ctx.slice();hist=[];bag=[]}
    else if(queue.indexOf(name)<0){queue=visibleNames();hist=[];bag=[]}
    if(playing&&playing!==name&&isFinite(audio.duration)&&!audio.ended)lastPos[playing]=audio.currentTime||0;
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
  updateAudioLoop();
  audio.addEventListener('loadedmetadata',function(){
    var f=map[playing];
    if(f){f.dur=audio.duration;if(!reorderOn)render()}
    if(resumeAt>0&&resumeAt<audio.duration-1){try{audio.currentTime=resumeAt}catch(e){}}
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
  audio.addEventListener('ended',function(){if(playing)lastPos[playing]=0;if(sleepOnEnded())return;syncPlayback();step(1)});
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
    updateAudioLoop();
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
      if(document.querySelector('.modal.show:not(#siteModal),.la-modal,.r2lib-shade,dialog[open]'))return;
      if($('siteModal').classList.contains('show'))closeSite();
      else if(queueEl.classList.contains('show'))toggleQueue(false);
      else closeNow();
      return;
    }
    if(t==='INPUT'||t==='SELECT'||t==='TEXTAREA'||document.querySelector('.modal.show,.la-modal,.r2lib-shade,dialog[open]'))return;
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
    plusEvent('admin');
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
  document.addEventListener('dragstart',function(e){if(!reorderOn)e.preventDefault()});


// 播放定时、桌面应用与共用扩展界面（插入原播放器闭包内）
var sleepState=null, sleepBaseVolume=1, sleepFading=false;
function updateAudioLoop(){audio.loop=mode==='one'&&!(sleepState&&sleepState.kind==='end')}
function sleepRestoreVolume(){if(sleepFading){try{audio.volume=sleepBaseVolume}catch(e){}sleepFading=false}}
function sleepSave(){try{if(sleepState)localStorage.setItem('r2m_sleep_v2',JSON.stringify(sleepState));else localStorage.removeItem('r2m_sleep_v2')}catch(e){}}
function sleepClear(){sleepState=null;sleepRestoreVolume();updateAudioLoop();sleepSave();sleepLabel()}
function sleepFinish(){sleepClear();audio.pause();syncPlayback();pSub.textContent='睡眠定时已停止';toast('睡眠定时已停止播放')}
function sleepOnEnded(){
  if(!sleepState)return false;
  if(sleepState.kind==='end'||Date.now()>=sleepState.deadline){sleepFinish();return true}
  return false;
}
function sleepTick(){
  if(!sleepState)return;
  var remain=sleepState.kind==='time'?(sleepState.deadline-Date.now())/1000:Math.max(0,(audio.duration||0)-audio.currentTime);
  if(sleepState.kind==='time'&&remain<=0){sleepFinish();return}
  if(sleepState.fade&&!audio.paused&&isFinite(remain)&&remain>0&&remain<15){
    if(!sleepFading){sleepBaseVolume=typeof audio.volume==='number'?audio.volume:1;sleepFading=true}
    try{audio.volume=sleepBaseVolume*Math.min(1,remain/15)}catch(e){}
  }
  sleepLabel();
}
function sleepLabel(){
  var t='睡眠定时';
  if(sleepState){t=sleepState.kind==='end'?'本曲结束停止':'定时 '+Math.max(1,Math.ceil((sleepState.deadline-Date.now())/60000))+' 分钟'}
  ['sleepButton','sleepNowButton'].forEach(function(id){var b=$(id);if(b){b.textContent=t;b.classList.toggle('active',!!sleepState)}});
  var text=$('sleepCurrent');if(text)text.textContent=sleepState?t:'当前未设置定时';
}
function sleepSet(kind,minutes){
  if(kind==='end'&&!playing){toast('先播放歌曲,再设置本曲结束停止',1);return}
  sleepRestoreVolume();
  sleepState={kind:kind,deadline:kind==='time'?Date.now()+Math.max(1,Math.min(180,minutes))*60000:0,fade:$('sleepFade').checked};
  sleepSave();updateAudioLoop();sleepLabel();plusCloseDialog('sleepModal');toast(kind==='end'?'本曲播放结束后停止':minutes+' 分钟后停止');
}
function plusOpenDialog(id){var m=$(id);m.classList.add('show');m.setAttribute('aria-hidden','false');var b=m.querySelector('button');if(b)try{b.focus({preventScroll:true})}catch(e){}}
function plusCloseDialog(id){var m=$(id);m.classList.remove('show');m.setAttribute('aria-hidden','true')}
(function(){
  var style=document.createElement('style');style.textContent=\`
  #plusToolbar{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 14px}
  #plusToolbar button{min-height:36px;font-size:12px}
  #nowExtras{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;margin:12px 0 0}
  #nowExtras button{min-height:32px;padding:4px 10px;border:1px solid rgba(255,255,255,.18);border-radius:18px;background:rgba(0,0,0,.18);color:rgba(255,255,255,.7);font-size:11px;cursor:pointer}
  #nowExtras button.active{color:white;border-color:rgba(255,255,255,.5)}
  .plus-modal{z-index:125}.plus-modal .sheet{max-height:88dvh;overflow:auto}
  .plus-modal label{display:block;margin:12px 0;color:var(--sub)}
  .plus-modal input[type=checkbox]{width:18px;height:18px;vertical-align:middle;margin-right:6px}
  .plus-options{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:14px 0}
  .plus-options button{height:42px;border:1px solid var(--hair2);border-radius:10px;background:var(--panel2);color:var(--txt);cursor:pointer}
  .plus-row{display:flex;gap:8px;align-items:center}.plus-row input{min-width:0;flex:1}.plus-row button{flex-shrink:0}
  .plus-note{font-size:12px;line-height:1.8;color:var(--sub);margin:12px 0;white-space:pre-line}
  .now-foot{margin-top:8px;font-size:9px}.now-inner{min-height:720px}
  @media(max-height:740px){.now-inner{min-height:620px}.now-stage{min-height:250px}.now-track{margin-bottom:12px}#nowExtras{margin-top:6px;gap:5px}}
  @media(max-width:360px){.wrap{padding-left:12px;padding-right:12px}.track{gap:7px;padding:10px 9px}.track .edit,.track .del{width:27px}.now-inner{padding-left:20px;padding-right:20px}}
  \`;document.head.appendChild(style);
  var modal=document.createElement('div');modal.className='modal plus-modal';modal.id='sleepModal';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-label','睡眠定时');modal.setAttribute('aria-hidden','true');
  modal.innerHTML='<div class="sheet"><h3>睡眠定时</h3><div class="hint" id="sleepCurrent">当前未设置定时</div><div class="plus-options"><button data-min="15">15 分钟</button><button data-min="30">30 分钟</button><button data-min="60">60 分钟</button></div><div class="plus-row"><input id="sleepMinutes" type="number" min="1" max="180" value="45" aria-label="自定义分钟"><button class="tbtn" id="sleepCustom">分钟后停止</button></div><label><input type="checkbox" id="sleepFade" checked>最后 15 秒音量渐弱</label><p class="plus-note">iOS 可能不允许网页调整音量,此时只会停止播放。应用被系统冻结或关闭后无法保证准时执行,回到页面会立即核对定时。</p><div class="btns"><button class="btn-no" id="sleepEnd">本曲结束停止</button><button class="btn-no" id="sleepCancel">取消定时</button></div><div class="btns"><button class="btn-ok" id="sleepClose">关闭</button></div></div>';
  document.body.appendChild(modal);
  [['plusToolbar','sleepButton'],['nowExtras','sleepNowButton']].forEach(function(pair){var b=document.createElement('button');b.type='button';b.className='tbtn';b.id=pair[1];b.textContent='睡眠定时';b.onclick=function(){sleepLabel();plusOpenDialog('sleepModal')};$(pair[0]).appendChild(b)});
  modal.querySelectorAll('[data-min]').forEach(function(b){b.onclick=function(){sleepSet('time',Number(b.dataset.min))}});
  $('sleepCustom').onclick=function(){var n=Number($('sleepMinutes').value);if(!Number.isInteger(n)||n<1||n>180){toast('请输入 1–180 分钟',1);return}sleepSet('time',n)};
  $('sleepEnd').onclick=function(){sleepSet('end',0)};$('sleepCancel').onclick=function(){sleepClear();plusCloseDialog('sleepModal');toast('定时已取消')};$('sleepClose').onclick=function(){plusCloseDialog('sleepModal')};
  modal.onclick=function(e){if(e.target===modal)plusCloseDialog('sleepModal')};
  try{var saved=JSON.parse(lsGet('r2m_sleep_v2','null'));if(saved&&saved.kind==='time'&&Number.isFinite(saved.deadline)&&saved.deadline>Date.now()&&saved.deadline<Date.now()+181*60000){sleepState={kind:'time',deadline:saved.deadline,fade:!!saved.fade}}else localStorage.removeItem('r2m_sleep_v2')}catch(e){}
  updateAudioLoop();sleepLabel();setInterval(sleepTick,1000);
  audio.addEventListener('timeupdate',sleepTick);audio.addEventListener('playing',sleepTick);
  document.addEventListener('visibilitychange',sleepTick);window.addEventListener('pageshow',sleepTick);
})();

(function(){
  var installEvent=null, pendingWorker=null;
  var dialog=document.createElement('div');dialog.id='installModal';dialog.className='modal plus-modal';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','添加到桌面');
  dialog.innerHTML='<div class="sheet"><h3>添加到手机桌面</h3><p class="plus-note" id="installText"></p><p class="plus-note">安装后以独立窗口打开。收藏和歌单存于当前浏览器/桌面应用,换设备请先导出歌单。歌曲仍从 R2 在线播放,离线只显示提示页；iOS 后台和锁屏播放仍受系统限制。</p><div class="btns"><button class="btn-no" id="installClose">关闭</button><button class="btn-ok" id="installNative" hidden>安装应用</button></div></div>';
  document.body.appendChild(dialog);
  var b=document.createElement('button');b.id='installButton';b.className='tbtn';b.textContent='添加到桌面';$('plusToolbar').appendChild(b);
  b.onclick=function(){
    var standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone;
    $('installText').textContent=standalone?'当前已在桌面应用中打开。':'iPhone / iPad：用 Safari 打开网页 → 点分享按钮 → 添加到主屏幕。\\n安卓 / 电脑：浏览器菜单 → 安装应用,或使用下方安装按钮。';
    $('installNative').hidden=!installEvent;plusOpenDialog('installModal');
  };
  $('installClose').onclick=function(){plusCloseDialog('installModal')};
  $('installNative').onclick=async function(){if(!installEvent)return;var event=installEvent;installEvent=null;await event.prompt();plusCloseDialog('installModal')};
  addEventListener('beforeinstallprompt',function(e){e.preventDefault();installEvent=e});
  addEventListener('appinstalled',function(){installEvent=null;b.textContent='已添加桌面'});
  var update=document.createElement('button');update.id='appUpdate';update.className='tbtn';update.textContent='应用有更新';update.hidden=true;$('plusToolbar').appendChild(update);
  update.onclick=function(){if(pendingWorker&&confirm('立即更新页面？播放会暂停,进度会保留。')){audio.pause();pendingWorker.postMessage({type:'SKIP_WAITING'})}};
  if('serviceWorker' in navigator&&location.protocol==='https:'){
    navigator.serviceWorker.register('/sw.js',{scope:'/'}).then(function(reg){
      function ready(){if(reg.waiting){pendingWorker=reg.waiting;update.hidden=false}}
      ready();reg.addEventListener('updatefound',function(){var worker=reg.installing;if(worker)worker.addEventListener('statechange',function(){if(worker.state==='installed'&&navigator.serviceWorker.controller)ready()})});
      var reloading=false;navigator.serviceWorker.addEventListener('controllerchange',function(){if(pendingWorker&&!reloading){reloading=true;location.reload()}});
    }).catch(function(){b.title='当前浏览器未启用离线提示,仍可添加到桌面'});
  }
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){['sleepModal','installModal'].forEach(function(id){plusCloseDialog(id)})}});
})();


/* R2 Music local library. Insert inside the main IIFE, before setAdmin/load.
 * Requires document events r2:loaded, r2:track, r2:render; no core overrides.
 * All library/history/resume data stays in this browser on this device.
 */
(function () {
  'use strict';
  /* LIB_CORE_START */
  function r2LibraryCore() {
    var LIMIT = { bytes: 1048576, favorites: 2000, playlists: 100, tracks: 2000, total: 10000, name: 1024, title: 80 };
    function fail(s) { throw new Error(s); }
    function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function object(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
    function keys(o, allowed) {
      if (!object(o) || Object.keys(o).some(function (k) { return allowed.indexOf(k) < 0; })) fail('JSON 包含不支持的字段');
    }
    function filename(n) { return typeof n === 'string' && n.length > 0 && n.length <= LIMIT.name && n.indexOf('\\u0000') < 0; }
    function title(n) {
      if (typeof n !== 'string' || !n.trim() || n.trim().length > LIMIT.title) fail('歌单名称须为 1–80 个字符');
      return n.trim();
    }
    function unique(a) { return Array.from(new Set(a)); }
    function names(a, max) {
      if (!Array.isArray(a) || a.length > max || !a.every(filename)) fail('歌曲条目无效或超过限制');
      return unique(a);
    }
    function empty() { return { format: 'r2-music-library', version: 1, favorites: [], playlists: [] }; }
    function validate(o) {
      keys(o, ['format', 'version', 'favorites', 'playlists', 'exportedAt']);
      if (o.format !== 'r2-music-library' || o.version !== 1) fail('不支持的歌单格式或版本');
      if (own(o, 'exportedAt') && (typeof o.exportedAt !== 'string' || o.exportedAt.length > 40)) fail('导出时间无效');
      var out = empty(), count = Array.isArray(o.favorites) ? o.favorites.length : 0;
      out.favorites = names(o.favorites, LIMIT.favorites);
      if (!Array.isArray(o.playlists) || o.playlists.length > LIMIT.playlists) fail('歌单数量超过限制');
      o.playlists.forEach(function (p) {
        keys(p, ['name', 'tracks']);
        var n = title(p.name), tracks = names(p.tracks, LIMIT.tracks);
        count += p.tracks.length;
        var prior = out.playlists.filter(function (x) { return x.name === n; })[0];
        if (prior) { prior.tracks = unique(prior.tracks.concat(tracks)); if (prior.tracks.length > LIMIT.tracks) fail('单个歌单超过 2000 首'); }
        else out.playlists.push({ name: n, tracks: tracks });
      });
      if (count > LIMIT.total) fail('总条目超过 10000 条');
      if (new TextEncoder().encode(JSON.stringify(out)).length > LIMIT.bytes - 80) fail('音乐库超过 1 MiB，请减少条目');
      return out;
    }
    function parse(text) {
      if (typeof text !== 'string' || new TextEncoder().encode(text).length > LIMIT.bytes) fail('JSON 文件不能超过 1 MiB');
      var o; try { o = JSON.parse(text); } catch (e) { fail('不是有效的 JSON 文件'); }
      return validate(o);
    }
    function merge(a, b) {
      var out = validate(a); b = validate(b);
      out.favorites = unique(out.favorites.concat(b.favorites));
      b.playlists.forEach(function (p) {
        var old = out.playlists.filter(function (x) { return x.name === p.name; })[0];
        if (old) old.tracks = unique(old.tracks.concat(p.tracks));
        else out.playlists.push({ name: p.name, tracks: p.tracks.slice() });
      });
      return validate(out);
    }
    function existing(a, m) { return unique(a).filter(function (n) { return filename(n) && own(m, n) && m[n] && m[n].name === n; }); }
    function summary(pack, m) {
      var all = unique(pack.favorites.concat.apply(pack.favorites, pack.playlists.map(function (p) { return p.tracks; })));
      var ok = new Set(existing(all, m));
      return { favorites: pack.favorites.length, playlists: pack.playlists.length, unique: all.length,
        entries: pack.favorites.length + pack.playlists.reduce(function (s, p) { return s + p.tracks.length; }, 0),
        unknown: all.filter(function (n) { return !ok.has(n); }) };
    }
    function history(a, name, at) {
      var seen = new Set(), out = [];
      var src = filename(name) ? [{ name: name, at: at }].concat(Array.isArray(a) ? a : []) : (Array.isArray(a) ? a : []);
      src.forEach(function (r) {
        if (out.length < 100 && object(r) && filename(r.name) && Number.isFinite(r.at) && r.at > 0 && !seen.has(r.name)) {
          seen.add(r.name); out.push({ name: r.name, at: r.at });
        }
      });
      return out;
    }
    function resume(o, m) {
      if (!object(o) || o.version !== 1 || !filename(o.name) || !existing([o.name], m).length ||
          !Number.isFinite(o.time) || o.time < 0 || o.time > 31536000 || !Number.isFinite(o.at) || o.at <= 0 ||
          ['loop', 'shuffle', 'one'].indexOf(o.mode) < 0 || !Array.isArray(o.queue) || o.queue.length > LIMIT.total || !o.queue.every(filename)) return null;
      var q = existing(o.queue, m); if (q.indexOf(o.name) < 0) { if (q.length === LIMIT.total) q.pop(); q.unshift(o.name); }
      return { version: 1, name: o.name, time: o.time, queue: q, mode: o.mode, at: o.at };
    }
    function move(a, i, delta) {
      var out = a.slice(), j = i + delta;
      if (Number.isInteger(i) && i >= 0 && i < out.length && j >= 0 && j < out.length && (delta === 1 || delta === -1)) {
        var n = out[i]; out[i] = out[j]; out[j] = n;
      }
      return out;
    }
    return { limit: LIMIT, empty: empty, validate: validate, parse: parse, merge: merge, summary: summary,
      filename: filename, title: title, unique: unique, existing: existing, history: history, resume: resume, move: move };
  }
  /* LIB_CORE_END */
  var core = r2LibraryCore(), LIB_KEY = 'r2m_library_v1', HIST_KEY = 'r2m_history_v1', RESUME_KEY = 'r2m_resume_v1';
  var library = core.empty(), recent = [], pendingResume = null, seekRestore = null;
  var activeName = null, heardName = null, savedAt = 0, warned = false, transient = false;
  var modal = null, panel = null, content = null, heading = null, notice = null, returnFocus = null;
  var toolbar = null, resumeBar = null, nowHeart = null, refreshView = null;
  function readJSON(key, fallback) {
    try { var s = lsGet(key, ''); return s && s.length <= core.limit.bytes ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
  }
  try { library = core.validate(readJSON(LIB_KEY, core.empty())); } catch (e) { library = core.empty(); }
  recent = core.history(readJSON(HIST_KEY, []));
  pendingResume = readJSON(RESUME_KEY, null);
  function inform(s, bad) { if (notice) notice.textContent = s; toast(s, bad ? 1 : 0); }
  function write(key, value) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) {
      transient = true;
      if (!warned) { warned = true; inform('设备存储不可用或已满；本次更改仅临时保留，请导出备份。', true); }
      return false;
    }
  }
  function commit(next) {
    try { next = core.validate(next); } catch (e) { inform(e.message, true); return false; }
    write(LIB_KEY, next); library = next; paintHearts(); return true;
  }
  function copyLibrary() { return core.validate(library); }
  function playlist(name, src) { return (src || library).playlists.filter(function (p) { return p.name === name; })[0]; }
  function known(name) { return core.existing([name], map).length > 0; }
  function label(name) { return known(name) ? (map[name].title || name) : name; }
  function element(tag, text, cls) {
    var n = document.createElement(tag); if (text !== undefined && text !== null) n.textContent = text;
    if (cls) n.className = cls; return n;
  }
  function button(text, action, cls) {
    var n = element('button', text, cls || 'r2lib-btn'); n.type = 'button';
    n.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); action(e); }); return n;
  }
  function group(parent) { var n = element('div', null, 'r2lib-actions'); parent.appendChild(n); return n; }
  function favorite(name) {
    if (!core.filename(name)) return;
    var next = copyLibrary(), i = next.favorites.indexOf(name);
    if (i < 0) next.favorites.push(name); else next.favorites.splice(i, 1);
    if (commit(next) && modal && refreshView) refreshView();
  }
  function updateHeart(b, name) {
    var on = library.favorites.indexOf(name) >= 0;
    b.textContent = on ? '♥' : '♡'; b.classList.toggle('r2lib-liked', on);
    b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', (on ? '取消收藏：' : '收藏：') + label(name));
    b.title = on ? '取消收藏' : '收藏';
  }
  function paintHearts() {
    document.querySelectorAll('.track[data-name]').forEach(function (row) {
      var name = row.getAttribute('data-name'), b = row.querySelector('.r2lib-heart');
      if (!b) { b = button('', function () { favorite(row.getAttribute('data-name')); }, 'r2lib-heart'); row.appendChild(b); }
      updateHeart(b, name);
    });
    if (nowHeart) { nowHeart.disabled = !playing || !known(playing); updateHeart(nowHeart, playing || ''); }
  }
  var style = element('style');
  style.textContent = '.r2lib-tools,.r2lib-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}.r2lib-tools{width:100%;margin:8px 0}.r2lib-btn,.r2lib-heart{box-sizing:border-box;min-height:44px;border:1px solid var(--hair,#ccc);border-radius:12px;background:var(--panel2,#eee);color:var(--txt,#222);font:inherit;cursor:pointer;padding:8px 12px;touch-action:manipulation;max-width:100%;overflow-wrap:anywhere}.r2lib-heart{width:44px;flex:0 0 44px;padding:0;font-size:25px}.r2lib-liked{color:var(--acc,#d24667);background:var(--acc-soft,#ffeaf0)}.r2lib-btn:disabled,.r2lib-heart:disabled{opacity:.4;cursor:default}.r2lib-btn:focus-visible,.r2lib-heart:focus-visible,.r2lib-panel input:focus-visible{outline:2px solid var(--acc,#b24e68);outline-offset:2px}.r2lib-resume{box-sizing:border-box;display:flex;flex-wrap:wrap;gap:8px;align-items:center;width:100%;padding:10px;border:1px solid var(--hair,#ccc);border-radius:14px}.r2lib-resume span{flex:1 1 160px;min-width:0;overflow-wrap:anywhere}.r2lib-shade{position:fixed;inset:0;z-index:120;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;overscroll-behavior:contain}.r2lib-panel{box-sizing:border-box;display:flex;flex-direction:column;width:min(620px,100%);max-width:100%;max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);border-radius:18px;background:var(--panel,#fff);color:var(--txt,#222);padding:16px;box-shadow:0 12px 50px #0005;font-size:14px;line-height:1.5;overflow:hidden}.r2lib-head{display:flex;gap:8px;align-items:center;flex-shrink:0}.r2lib-head h2{font-size:18px;flex:1;min-width:0;overflow-wrap:anywhere;margin:0}.r2lib-content{overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;min-height:0;padding:8px 2px}.r2lib-note{font-size:12px;opacity:.75;overflow-wrap:anywhere;margin:8px 0}.r2lib-notice{font-size:13px;color:var(--acc,#b24665);flex-shrink:0;overflow-wrap:anywhere}.r2lib-row{padding:10px 0;border-bottom:1px solid var(--hair,#ddd);min-width:0}.r2lib-rowtitle{display:block;overflow-wrap:anywhere;margin:0 0 7px}.r2lib-panel input[type=text],.r2lib-panel input[type=search]{font:inherit;font-size:16px;box-sizing:border-box;width:100%;min-width:0;min-height:44px;padding:8px;border:1px solid var(--hair,#ccc);border-radius:10px;background:var(--panel2,#eee);color:inherit;margin:8px 0}.r2lib-check{display:flex;align-items:center;gap:10px;min-height:44px;overflow-wrap:anywhere;padding:7px 0}.r2lib-check input{width:22px;height:22px;flex:0 0 22px}.r2lib-check span{min-width:0}.r2lib-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.r2lib-pagination{margin:10px 0}@media(max-width:360px){.r2lib-panel{padding:12px}.track:has(.r2lib-heart){gap:6px;padding-left:8px;padding-right:8px}}';
  document.head.appendChild(style);
  function closeLibrary() {
    if (!modal) return;
    modal.remove(); modal = panel = content = heading = notice = null; refreshView = null;
    if (returnFocus && returnFocus.isConnected) { try { returnFocus.focus({ preventScroll: true }); } catch (e) {} }
  }
  function openLibrary() {
    if (modal) { showHome(); return; }
    returnFocus = document.activeElement;
    modal = element('div', null, 'r2lib-shade');
    panel = element('section', null, 'r2lib-panel'); panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'r2lib-title');
    var head = element('div', null, 'r2lib-head');
    heading = element('h2', '我的音乐'); heading.id = 'r2lib-title'; heading.tabIndex = -1;
    head.appendChild(heading); head.appendChild(button('关闭', closeLibrary)); panel.appendChild(head);
    panel.appendChild(element('p', '仅保存在当前设备、当前浏览器，不会跨设备同步；清理网站数据会丢失，请导出备份。', 'r2lib-note'));
    notice = element('div', '', 'r2lib-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); panel.appendChild(notice);
    content = element('div', null, 'r2lib-content'); panel.appendChild(content); modal.appendChild(panel);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeLibrary(); });
    document.body.appendChild(modal); showHome();
  }
  function screen(title, refresher) {
    if (!modal) return false;
    heading.textContent = title; content.replaceChildren(); content.scrollTop = 0;
    notice.textContent = transient ? '存储不可用：本次更改仅临时保留，请导出备份。' : '';
    refreshView = refresher || null;
    heading.focus({ preventScroll: true }); return true;
  }
  function homeBack() { content.appendChild(button('‹ 我的音乐', showHome)); }
  function pages(items, renderItems, host) {
    var page = 0, size = 40, nav = element('div', null, 'r2lib-actions r2lib-pagination'), rows = element('div');
    host.appendChild(nav); host.appendChild(rows);
    function draw() {
      nav.replaceChildren(); rows.replaceChildren();
      var total = Math.max(1, Math.ceil(items.length / size)); page = Math.min(page, total - 1);
      var prev = button('上一页', function () { page--; draw(); }), next = button('下一页', function () { page++; draw(); });
      prev.disabled = page === 0; next.disabled = page >= total - 1;
      if (items.length > size) { nav.appendChild(prev); nav.appendChild(element('span', (page + 1) + ' / ' + total)); nav.appendChild(next); }
      renderItems(items.slice(page * size, (page + 1) * size), rows, page * size);
    }
    draw();
  }
  function showHome() {
    if (!screen('我的音乐', showHome)) return;
    var actions = group(content);
    actions.appendChild(button('收藏 · ' + library.favorites.length, function () { showCollection('favorites'); }));
    actions.appendChild(button('最近播放 · ' + recent.length, function () { showCollection('history'); }));
    actions.appendChild(button('新建歌单', function () { showEditor(null); }));
    actions.appendChild(button('导出 JSON', exportLibrary));
    var input = element('input', null, 'r2lib-file'); input.type = 'file'; input.accept = '.json,application/json'; input.tabIndex = -1;
    input.setAttribute('aria-label', '导入歌单 JSON'); content.appendChild(input);
    actions.appendChild(button('导入 JSON', function () { input.click(); }));
    input.addEventListener('change', function () {
      var file = input.files && input.files[0]; input.value = ''; if (!file) return;
      if (file.size > core.limit.bytes) { inform('JSON 文件不能超过 1 MiB', true); return; }
      var target = content;
      file.text().then(function (text) { var pack = core.parse(text); if (modal && content === target) previewImport(pack); })
        .catch(function (e) { if (modal && content === target) inform(e.message || '读取失败', true); });
    });
    content.appendChild(element('p', '导入最多 1 MiB / 100 个歌单 / 每单 2000 首 / 总计 10000 条；只合并收藏与歌单，不导入设置或登录信息。', 'r2lib-note'));
    if (!library.playlists.length) content.appendChild(element('p', '还没有自建歌单，点击“新建歌单”开始。'));
    library.playlists.forEach(function (p) {
      var row = element('div', null, 'r2lib-row');
      row.appendChild(button(p.name + ' · ' + p.tracks.length + ' 首', function () { showCollection('playlist', p.name); })); content.appendChild(row);
    });
  }
  function confirmAction(title, text, action, back) {
    if (!screen(title)) return;
    content.appendChild(element('p', text)); var a = group(content);
    a.appendChild(button('取消', back)); a.appendChild(button('确认', action));
  }
  function showEditor(oldName) {
    if (!screen(oldName === null ? '新建歌单' : '重命名歌单')) return;
    var back = function () { oldName === null ? showHome() : showCollection('playlist', oldName); };
    var form = element('form'), input = element('input'); input.type = 'text'; input.maxLength = core.limit.title;
    input.value = oldName || ''; input.id = 'r2lib-playlist-name'; input.autocomplete = 'off';
    var lbl = element('label', '歌单名称（1–80 个字符）'); lbl.htmlFor = input.id; form.appendChild(lbl); form.appendChild(input);
    var a = group(form); a.appendChild(button('取消', back));
    function save() {
      var n; try { n = core.title(input.value); } catch (e) { inform(e.message, true); return; }
      if (n !== oldName && playlist(n)) { inform('已存在同名歌单，请换一个名称', true); return; }
      var next = copyLibrary();
      if (oldName === null) next.playlists.push({ name: n, tracks: [] });
      else { var p = playlist(oldName, next); if (!p) { showHome(); return; } p.name = n; }
      if (commit(next)) showCollection('playlist', n);
    }
    a.appendChild(button('保存', save)); form.addEventListener('submit', function (e) { e.preventDefault(); save(); });
    content.appendChild(form); input.focus();
  }
  function playCollection(name, names, ordered) {
    var ctx = core.existing(names, map);
    if (!ctx.length || ctx.indexOf(name) < 0) { inform('歌曲已不在当前曲库', true); return; }
    if (ordered) setMode('loop', true);
    closeLibrary(); play(name, ctx);
  }
  function showCollection(kind, name) {
    var p = kind === 'playlist' ? playlist(name) : null;
    if (kind === 'playlist' && !p) { showHome(); return; }
    var title = kind === 'playlist' ? name : (kind === 'favorites' ? '我的收藏' : '最近播放');
    var names = kind === 'playlist' ? p.tracks.slice() : (kind === 'favorites' ? library.favorites.slice() : recent.map(function (r) { return r.name; }));
    var again = function () { showCollection(kind, name); };
    if (!screen(title, again)) return;
    homeBack(); var a = group(content), playable = core.existing(names, map);
    var all = button('顺序播放 · ' + playable.length + ' 首', function () { playCollection(playable[0], names, true); }); all.disabled = !playable.length; a.appendChild(all);
    if (kind === 'playlist') {
      a.appendChild(button('选择歌曲', function () { showPicker(name); }));
      a.appendChild(button('改名', function () { showEditor(name); }));
      a.appendChild(button('删除歌单', function () { confirmAction('删除歌单？', '仅删除本设备歌单“' + name + '”，不会删除音频文件。', function () {
        var next = copyLibrary(); next.playlists = next.playlists.filter(function (x) { return x.name !== name; }); if (commit(next)) showHome();
      }, again); }));
    }
    if (kind === 'history') a.appendChild(button('清空历史', function () { confirmAction('清空最近播放？', '仅清空本设备的播放历史，不删除收藏和歌单。', function () { recent = []; write(HIST_KEY, recent); again(); }, again); }));
    content.appendChild(element('p', names.length + ' 首 · ' + (names.length - playable.length) + ' 首文件不在当前曲库' + (kind === 'history' ? ' · 最多保留最近 100 首' : ''), 'r2lib-note'));
    if (!names.length) content.appendChild(element('p', kind === 'favorites' ? '点击歌曲旁的爱心即可收藏。' : '列表还是空的。'));
    pages(names, function (part, rows, offset) {
      part.forEach(function (n, j) {
        var index = offset + j, row = element('div', null, 'r2lib-row'), text = (index + 1) + '. ' + label(n);
        row.appendChild(element('strong', text, 'r2lib-rowtitle'));
        if (!known(n)) row.appendChild(element('p', '文件不在当前曲库（保留记录）', 'r2lib-note'));
        if (kind === 'history') { var r = recent.filter(function (x) { return x.name === n; })[0]; if (r) row.appendChild(element('p', new Date(r.at).toLocaleString(), 'r2lib-note')); }
        var acts = group(row), b = button('播放', function () { playCollection(n, names, false); }); b.disabled = !known(n); acts.appendChild(b);
        var heart = button('', function () { favorite(n); }); updateHeart(heart, n); acts.appendChild(heart);
        if (kind === 'playlist') {
          [-1, 1].forEach(function (d) {
            var move = button(d < 0 ? '上移' : '下移', function () { var next = copyLibrary(), x = playlist(name, next); x.tracks = core.move(x.tracks, index, d); if (commit(next)) again(); });
            move.disabled = d < 0 ? index === 0 : index === names.length - 1; acts.appendChild(move);
          });
          acts.appendChild(button('移除', function () { var next = copyLibrary(), x = playlist(name, next); x.tracks = x.tracks.filter(function (s) { return s !== n; }); if (commit(next)) again(); }));
        }
        rows.appendChild(row);
      });
    }, content);
  }
  function showPicker(name) {
    var p = playlist(name); if (!p) { showHome(); return; }
    if (!screen('选择歌曲 · ' + name)) return;
    var selected = new Set(p.tracks), a = group(content), count = element('p', '', 'r2lib-note');
    function countText() { count.textContent = '已选择 ' + selected.size + ' 首；取消勾选可移除，保存后生效。'; }
    a.appendChild(button('取消', function () { showCollection('playlist', name); }));
    a.appendChild(button('保存选择', function () {
      var next = copyLibrary(), x = playlist(name, next); if (!x) { showHome(); return; }
      x.tracks = Array.from(selected); if (commit(next)) showCollection('playlist', name);
    }));
    content.appendChild(count); countText();
    var search = element('input'); search.type = 'search'; search.placeholder = '搜索歌名、文件名或歌手'; search.setAttribute('aria-label', search.placeholder);
    content.appendChild(search); var results = element('div'); content.appendChild(results);
    function draw() {
      var kw = search.value.trim().toLowerCase(); results.replaceChildren();
      var files = list.filter(function (f) { return known(f.name) && (!kw || [f.name, f.title, f.artist, f.album].join(' ').toLowerCase().indexOf(kw) >= 0); });
      if (!files.length) results.appendChild(element('p', '没有匹配歌曲。'));
      pages(files, function (part, rows) {
        part.forEach(function (f) {
          var row = element('label', null, 'r2lib-check'), box = element('input'); box.type = 'checkbox'; box.checked = selected.has(f.name);
          box.addEventListener('change', function () { if (box.checked) selected.add(f.name); else selected.delete(f.name); countText(); });
          row.appendChild(box); row.appendChild(element('span', (f.title || f.name) + (f.artist ? ' · ' + f.artist : ''))); rows.appendChild(row);
        });
      }, results);
    }
    search.addEventListener('input', draw); draw();
  }
  function exportLibrary() {
    var out = copyLibrary(); out.exportedAt = new Date().toISOString();
    var blob = new Blob([JSON.stringify(out)], { type: 'application/json;charset=utf-8' });
    if (blob.size > core.limit.bytes) { inform('导出文件超过 1 MiB；请减少条目后再导出，以便安全导入。', true); return; }
    var url = URL.createObjectURL(blob), a = element('a'); a.href = url; a.download = 'r2-music-library-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }
  function previewImport(pack) {
    var merged, s;
    try { merged = core.merge(library, pack); s = core.summary(pack, map); } catch (e) { inform(e.message, true); return; }
    if (!screen('导入预览')) return;
    content.appendChild(element('p', '待导入：' + s.favorites + ' 个收藏、' + s.playlists + ' 个歌单、' + s.entries + ' 个条目（' + s.unique + ' 个不同文件）。'));
    content.appendChild(element('p', '合并后：' + merged.favorites.length + ' 个收藏、' + merged.playlists.length + ' 个歌单。同名歌单按名称合并；重复歌曲去重，现有顺序优先。'));
    content.appendChild(element('p', '未知文件 ' + s.unknown.length + ' 个：会保留名称，但文件出现在当前曲库前不能播放。不上传音频、不修改设置。'));
    var a = group(content);
    a.appendChild(button('取消', showHome));
    a.appendChild(button('确认合并', function () {
      try { if (commit(core.merge(library, pack))) { showHome(); inform(transient ? '已合并到临时音乐库；请导出备份' : '已合并到当前设备'); } } catch (e) { inform(e.message, true); }
    }));
    if (s.unknown.length) pages(s.unknown, function (part, rows) { part.forEach(function (n) { rows.appendChild(element('p', n, 'r2lib-rowtitle')); }); }, content);
  }
  function mount() {
    var host = $('plusToolbar');
    if (host && !toolbar) {
      toolbar = element('div', null, 'r2lib-tools'); toolbar.id = 'r2lib-tools';
      toolbar.appendChild(button('我的音乐', openLibrary)); host.appendChild(toolbar);
      resumeBar = element('div', null, 'r2lib-resume'); resumeBar.hidden = true; resumeBar.style.display = 'none'; toolbar.appendChild(resumeBar);
    }
    var extra = $('nowExtras');
    if (extra && !nowHeart) {
      nowHeart = button('', function () { if (playing) favorite(playing); }, 'r2lib-heart'); extra.appendChild(nowHeart);
      extra.appendChild(button('我的音乐', openLibrary));
    }
    paintHearts();
  }
  function clearResume() { pendingResume = null; write(RESUME_KEY, null); showResume(); }
  function showResume() {
    if (!resumeBar) return;
    var r = core.resume(pendingResume, map); resumeBar.replaceChildren();
    var visible = !!r && !playing; resumeBar.hidden = !visible; resumeBar.style.display = visible ? 'flex' : 'none';
    if (!visible) return;
    var seconds = Math.floor(r.time), stamp = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    resumeBar.appendChild(element('span', '继续上次播放：' + label(r.name) + ' · ' + stamp));
    resumeBar.appendChild(button('继续播放', function () {
      var fresh = core.resume(pendingResume, map); if (!fresh) { clearResume(); return; }
      pendingResume = null; seekRestore = { name: fresh.name, time: fresh.time };
      lastPos[fresh.name] = fresh.time; setMode(fresh.mode, true);
      play(fresh.name, fresh.queue); showResume();
    }));
    resumeBar.appendChild(button('关闭', clearResume));
  }
  function applyRestore() {
    if (!seekRestore) return;
    if (seekRestore.name !== playing) { seekRestore = null; return; }
    if (!(Number.isFinite(audio.duration) && audio.duration > 0 && audio.readyState >= 1)) return;
    var time = Math.min(seekRestore.time, Math.max(0, audio.duration - 0.25));
    try { audio.currentTime = time; lastPos[playing] = time; resumeAt = 0; seekRestore = null; } catch (e) {}
  }
  function saveMemory(force) {
    if (!playing || activeName !== playing || !known(playing)) return;
    var now = Date.now(); if (!force && now - savedAt < 5000) return;
    var t = seekRestore && seekRestore.name === playing ? seekRestore.time : audio.currentTime;
    if (!Number.isFinite(t) || t < 0) return;
    var q = core.existing(queue, map).slice(0, core.limit.total);
    if (q.indexOf(playing) < 0) { if (q.length === core.limit.total) q.pop(); q.unshift(playing); }
    var r = { version: 1, name: playing, time: audio.ended ? 0 : t, queue: q, mode: mode, at: now };
    if (!core.resume(r, map)) return;
    lastPos[playing] = r.time; write(RESUME_KEY, r); savedAt = now;
  }
  document.addEventListener('r2:loaded', function () { mount(); showResume(); if (modal && refreshView) refreshView(); });
  document.addEventListener('r2:render', function () { mount(); });
  document.addEventListener('r2:track', function () {
    if (seekRestore && seekRestore.name !== playing) seekRestore = null;
    paintHearts(); showResume();
  });
  document.addEventListener('r2:admin', paintHearts);
  audio.addEventListener('loadedmetadata', applyRestore);
  audio.addEventListener('durationchange', applyRestore);
  audio.addEventListener('playing', function () {
    if (!playing || !known(playing) || audio.paused) return;
    applyRestore(); activeName = playing;
    if (heardName !== playing) { recent = core.history(recent, playing, Date.now()); write(HIST_KEY, recent); heardName = playing; }
    pendingResume = null; showResume(); saveMemory(true);
  });
  audio.addEventListener('timeupdate', function () { saveMemory(false); });
  audio.addEventListener('pause', function () { saveMemory(true); heardName = null; });
  audio.addEventListener('emptied', function () { activeName = null; heardName = null; });
  audio.addEventListener('seeked', function () { saveMemory(false); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') saveMemory(true); });
  window.addEventListener('pagehide', function () { saveMemory(true); });
  // Capture only while our dialog is open: isolate the base global player shortcuts.
  document.addEventListener('keydown', function (e) {
    if (!modal) return;
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeLibrary(); return; }
    if (e.key !== 'Tab') return;
    var nodes = Array.from(panel.querySelectorAll('button:not([disabled]),input:not([disabled]),[tabindex="0"]')).filter(function (n) { return n.tabIndex >= 0 && n.getClientRects().length; });
    if (!nodes.length) { e.preventDefault(); heading.focus(); return; }
    var first = nodes[0], last = nodes[nodes.length - 1], current = document.activeElement;
    if (e.shiftKey && (current === first || !nodes.includes(current))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (current === last || !nodes.includes(current))) { e.preventDefault(); first.focus(); }
  }, true);
  mount();
})();


/* Plain browser JS. Insert inside the existing main IIFE before setAdmin()/load(). */
(function () {
  'use strict';
  // LA_PURE_BEGIN -- vm-testable, no DOM or closure dependencies.
  function laParseLRC(source) {
    var raw = String(source == null ? '' : source).replace(/^\\uFEFF/, '').replace(/\\r\\n?/g, '\\n');
    var offsetMs = 0, entries = [], plain = [], order = 0;
    raw.replace(/\\[offset\\s*:\\s*([+-]?\\d+)\\s*\\]/gi, function (_, value) {
      var n = Number(value); if (Number.isFinite(n)) offsetMs = n; return '';
    });
    raw.split('\\n').forEach(function (line) {
      var times = [];
      var text = line.replace(/\\[(?:(\\d+):)?(\\d{1,3}):(\\d{2})(?:\\.(\\d{1,3}))?\\]/g, function (tag, h, m, s, fraction) {
        if (Number(s) >= 60 || (h != null && Number(m) >= 60)) return tag;
        times.push((Number(h) || 0) * 3600 + Number(m) * 60 + Number(s) + (fraction ? Number('0.' + fraction) : 0));
        return '';
      }).replace(/\\[(?:ar|ti|al|by|re|ve|length|id|au|offset)\\s*:[^\\]]*\\]/gi, '').trim();
      if (times.length) times.forEach(function (time) { entries.push({ time: time - offsetMs / 1000, text: text, order: order++ }); });
      else if (text) plain.push(text);
    });
    entries.sort(function (a, b) { return a.time - b.time || a.order - b.order; });
    var lines = [];
    entries.forEach(function (entry) {
      var last = lines[lines.length - 1];
      if (last && last.time === entry.time) { if (entry.text && last.text !== entry.text) last.text += (last.text ? '\\n' : '') + entry.text; }
      else lines.push({ time: entry.time, text: entry.text });
    });
    return { timed: !!lines.length, lines: lines, plain: plain, offsetMs: offsetMs };
  }
  function laActiveIndex(lines, currentTime, localDelay) {
    var target = currentTime - localDelay, lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (lines[mid].time <= target) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found;
  }
  function laClampOffset(value) {
    var n = Number(value); return Number.isFinite(n) ? Math.max(-60, Math.min(60, Math.round(n * 2) / 2)) : 0;
  }
  // LA_PURE_END
  var laDefaults = { brightness: 0.78, blur: 24, discSize: 100, spinSeconds: 18 };
  var laBounds = { brightness: [0.2, 1], blur: [0, 40], discSize: [70, 100], spinSeconds: [10, 60] };
  var laAppearance = Object.assign({ albums: Object.create(null) }, laDefaults), laPreview = null;
  var laAppearanceEpoch = 0, laAppearancePending = null, laAppearanceReady = false;
  var laCache = new Map(), laTrackEpoch = 0, laName = '', laParsed = laParseLRC(''), laActive = -2, laRowNodes = [];
  var laLocalOffset = 0, laManualUntil = 0, laLyricsVisible = false, laModal = null, laBackgroundURL = '', laBadBackgrounds = new Set();
  function laEl(tag, cls, text) { var el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; }
  function laButton(text, handler, parent) { var el = laEl('button', 'la-button', text); el.type = 'button'; el.addEventListener('click', handler); if (parent) parent.appendChild(el); return el; }
  function laHint(text, parent) { var el = laEl('p', 'la-hint', text); if (parent) parent.appendChild(el); return el; }
  function laError(error) { toast(error && error.message ? error.message : '操作失败，请重试', 1); }
  function laOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function laTrack() { return playing && laOwn(map, playing) ? map[playing] : null; }
  function laLyricsURL(name) { return '/api/lyrics?name=' + encodeURIComponent(name); }
  function laAlbumURL(album, version) { return '/api/album-background?album=' + encodeURIComponent(album) + (version ? '&v=' + encodeURIComponent(version) : ''); }
  function laJSON(response) { return response.json().catch(function () { throw new Error('服务器返回了无效 JSON'); }).then(function (value) { if (!response.ok) throw new Error(value.error || 'HTTP ' + response.status); return value; }); }
  function laAdminJSON(method, url, body, type) { return api(method, url, body, type).then(laJSON); }
  function laGetLyrics(name, force) {
    if (!force && laCache.has(name)) return laCache.get(name).promise;
    var entry = {};
    entry.promise = fetch(laLyricsURL(name), { cache: 'no-store' }).then(laJSON).then(function (value) {
      return { lrc: typeof value.lrc === 'string' ? value.lrc : '' };
    });
    laCache.set(name, entry);
    return entry.promise;
  }
  function laCacheLyrics(name, value) { laCache.set(name, { promise: Promise.resolve({ lrc: value }) }); }
  var laStyle = laEl('style'); laStyle.id = 'laStyles';
  laStyle.textContent = \`
:root{--la-brightness:.78;--la-blur:24px;--la-disc-scale:1;--la-spin:18s}
#nowBg.now-bg{filter:blur(var(--la-blur)) brightness(var(--la-brightness));opacity:1}
#nowPlaying .now-deck{transform:scale(var(--la-disc-scale));transform-origin:center}
#nowPlaying .now-disc{animation-duration:var(--la-spin);cursor:pointer}
#nowPlaying .now-disc:focus-visible{outline:2px solid white;outline-offset:8px}
#plusToolbar,#nowExtras{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
#plusToolbar{margin:12px 0}#nowExtras{margin:12px 0 4px;justify-content:center;letter-spacing:0}
.la-button{font:inherit;font-size:13px;color:inherit;border:1px solid currentColor;border-radius:12px;background:transparent;padding:9px 13px;min-height:40px;cursor:pointer;opacity:.88}
.la-button:hover{opacity:1;background:rgba(128,128,128,.12)}.la-button:disabled{opacity:.4;cursor:default}
.la-button:focus-visible,.la-modal :focus-visible{outline:2px solid var(--accent,#6998ff);outline-offset:3px}
.la-button.la-primary{background:#547eea;color:#fff;border-color:#547eea}.la-danger{color:#f07878}
.la-lyrics{display:none;width:100%;height:clamp(220px,40dvh,450px);min-height:0;flex-direction:column;gap:8px}
#nowPlaying.la-lyrics-on .now-deck{display:none}#nowPlaying.la-lyrics-on .la-lyrics{display:flex}
#nowPlaying.la-lyrics-on .now-stage{padding:12px 0;min-height:240px}
.la-lines{position:relative;flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:35% 8px;scrollbar-width:thin;mask-image:linear-gradient(transparent,#000 12%,#000 88%,transparent)}
.la-line{display:block;border:0;background:none;color:rgba(255,255,255,.46);font:inherit;font-size:19px;line-height:1.55;font-weight:500;text-align:center;width:100%;padding:12px 6px;white-space:pre-wrap;overflow-wrap:anywhere;transition:color .2s,opacity .2s;cursor:pointer}
.la-line.is-active{color:#fff;font-weight:700}.la-line:focus-visible{outline:1px solid white;outline-offset:-2px}
.la-plain{color:rgba(255,255,255,.85);font-size:18px;line-height:1.9;white-space:pre-wrap;text-align:center;overflow-wrap:anywhere}
.la-lyric-info{color:rgba(255,255,255,.65);font-size:12px;text-align:center;min-height:18px}
.la-offset{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;color:rgba(255,255,255,.8);font-size:12px}.la-offset input{width:65px;padding:6px;font-size:16px;color:inherit;background:rgba(0,0,0,.2);border:1px solid #888;border-radius:8px}.la-offset .la-button{font-size:11px;min-height:34px;padding:5px 8px}
.la-modal{position:fixed;inset:0;z-index:120;background:rgba(0,0,0,.64);display:flex;align-items:center;justify-content:center;padding:max(16px,env(safe-area-inset-top)) 14px max(16px,env(safe-area-inset-bottom));color:var(--txt,#edf0fa)}
.la-dialog{background:var(--bg,#171a23);border:1px solid rgba(128,128,128,.3);border-radius:20px;width:100%;max-width:540px;max-height:100%;overflow-y:auto;overscroll-behavior:contain;padding:20px;box-shadow:0 20px 80px #0008}
.la-dialog h2{font-size:20px;margin:0}.la-dialog h3{font-size:15px;margin:24px 0 8px}.la-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.la-head h2{flex:1}
.la-hint{font-size:12px;color:var(--dim,#9ba3b8);line-height:1.6;margin:8px 0;overflow-wrap:anywhere}.la-field{display:block;margin:14px 0;font-size:13px}.la-field select,.la-field textarea{display:block;margin-top:8px;width:100%;font:inherit;font-size:16px;color:inherit;background:var(--bg,#171a23);border:1px solid #8886;border-radius:10px;padding:10px}.la-field textarea{min-height:220px;resize:vertical;line-height:1.5;white-space:pre-wrap}.la-field input[type=range]{display:block;width:100%;margin:12px 0;accent-color:#6c91ed}.la-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.la-preview{display:block;width:100%;height:125px;object-fit:cover;border-radius:12px;margin:8px 0}.la-preview[hidden],.la-offset[hidden],[hidden].la-button{display:none!important}
@media(max-width:420px){.la-dialog{padding:16px}.la-button{font-size:12px;padding:8px 10px}.la-offset{gap:4px}.la-line{font-size:18px}.la-lines{padding:40% 3px}}
@media(orientation:landscape) and (max-height:560px){.la-lyrics{height:240px}.la-modal{padding:8px}.la-dialog{max-height:95dvh}}
@media(prefers-reduced-motion:reduce){#nowPlaying .now-disc{animation-play-state:paused!important}.la-line{transition:none}}
\`;
  document.head.appendChild(laStyle);
  function laShowModal(title, onClose) {
    if (laModal) laModal.close();
    var overlay = laEl('div', 'la-modal'), box = laEl('section', 'la-dialog'), head = laEl('div', 'la-head');
    var heading = laEl('h2', '', title); heading.id = 'laModalTitle'; box.setAttribute('aria-labelledby', heading.id);
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.tabIndex = -1;
    head.appendChild(heading); box.appendChild(head); overlay.appendChild(box);
    var previousFocus = document.activeElement, oldOverflow = document.body.style.overflow;
    var inerted = [document.querySelector('.wrap'), nowPlayer, $('playerBar'), $('queue')].filter(function (el) { return el && !el.hasAttribute('inert'); });
    inerted.forEach(function (el) { el.setAttribute('inert', ''); }); document.body.style.overflow = 'hidden';
    var modal = { box: box, overlay: overlay, close: function () {
      if (laModal !== modal) return;
      laModal = null; overlay.remove(); inerted.forEach(function (el) { el.removeAttribute('inert'); });
      document.body.style.overflow = oldOverflow; if (onClose) onClose();
      if (previousFocus && previousFocus.isConnected) try { previousFocus.focus({ preventScroll: true }); } catch (_) {}
    } };
    laButton('关闭', modal.close, head); overlay.addEventListener('click', function (e) { if (e.target === overlay) modal.close(); });
    ['dragenter', 'dragover', 'drop'].forEach(function (type) { overlay.addEventListener(type, function (e) { e.preventDefault(); e.stopPropagation(); }); });
    laModal = modal; document.body.appendChild(overlay); box.focus({ preventScroll: true }); return modal;
  }
  document.addEventListener('keydown', function (e) {
    if (!laModal) return;
    // Capture phase prevents the original Escape/arrow/space handlers from closing the player.
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { e.preventDefault(); laModal.close(); return; }
    if (e.key === 'Tab') {
      var nodes = Array.from(laModal.box.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(function (el) { return !el.hidden && el.getClientRects().length; });
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) { e.preventDefault(); laModal.box.focus(); }
      else if (e.shiftKey && (document.activeElement === first || document.activeElement === laModal.box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === laModal.box)) { e.preventDefault(); first.focus(); }
    }
  }, true);
  var laPanel = laEl('div', 'la-lyrics'); laPanel.id = 'laLyrics';
  var laInfo = laEl('div', 'la-lyric-info', '选择歌曲后显示歌词'), laLines = laEl('div', 'la-lines');
  laLines.setAttribute('role', 'region'); laLines.setAttribute('aria-label', '歌词，点击时间轴行可跳转');
  var laOffsetBar = laEl('div', 'la-offset'), laOffsetInput = laEl('input');
  laOffsetInput.type = 'number'; laOffsetInput.min = '-60'; laOffsetInput.max = '60'; laOffsetInput.step = '0.5'; laOffsetInput.value = '0';
  laOffsetInput.setAttribute('aria-label', '本机歌词延后秒数，负数为提前');
  laPanel.appendChild(laInfo); laPanel.appendChild(laLines); laPanel.appendChild(laOffsetBar);
  document.querySelector('#nowPlaying .now-stage').appendChild(laPanel);
  function laSetOffset(value) {
    laLocalOffset = laClampOffset(value); laOffsetInput.value = String(laLocalOffset);
    if (laName) lsSet('r2m_lyric_offset:' + encodeURIComponent(laName), String(laLocalOffset));
    laManualUntil = 0; laSyncLine(true);
  }
  laButton('提前 0.5s', function () { laSetOffset(laLocalOffset - 0.5); }, laOffsetBar);
  laOffsetBar.appendChild(laOffsetInput);
  laButton('延后 0.5s', function () { laSetOffset(laLocalOffset + 0.5); }, laOffsetBar);
  laButton('重置', function () { laSetOffset(0); }, laOffsetBar);
  laButton('跟随', function () { laManualUntil = 0; laSyncLine(true); }, laOffsetBar);
  laOffsetInput.addEventListener('change', function () { laSetOffset(laOffsetInput.value); });
  ['wheel', 'touchstart', 'pointerdown'].forEach(function (type) { laLines.addEventListener(type, function () { laManualUntil = Date.now() + 3500; }, { passive: true }); });
  var laScrollFallback = 0;
  function laScrollLine(index) {
    clearTimeout(laScrollFallback);
    if (!laLyricsVisible || !nowOpen || Date.now() < laManualUntil || !laRowNodes[index]) return;
    var node = laRowNodes[index];
    var top = Math.max(0, Math.min(laLines.scrollHeight - laLines.clientHeight, node.offsetTop - (laLines.clientHeight - node.offsetHeight) / 2));
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    laLines.scrollTo({ top: top, behavior: reduced ? 'auto' : 'smooth' });
    // Some embedded WebKit views suspend smooth animations; settle once, never per frame.
    if (!reduced) laScrollFallback = setTimeout(function () {
      if (node === laRowNodes[index] && laLyricsVisible && nowOpen && Date.now() >= laManualUntil && Math.abs(laLines.scrollTop - top) > 2) laLines.scrollTo({ top: top, behavior: 'auto' });
    }, 450);
  }
  function laSyncLine(force) {
    if (!laParsed.timed) return;
    var next = laActiveIndex(laParsed.lines, Number(audio.currentTime) || 0, laLocalOffset);
    if (next !== laActive) {
      if (laRowNodes[laActive]) { laRowNodes[laActive].classList.remove('is-active'); laRowNodes[laActive].removeAttribute('aria-current'); }
      laActive = next;
      if (laRowNodes[next]) { laRowNodes[next].classList.add('is-active'); laRowNodes[next].setAttribute('aria-current', 'true'); }
      laScrollLine(Math.max(0, next));
    } else if (force) laScrollLine(Math.max(0, next));
  }
  function laRenderLyrics(text) {
    laParsed = laParseLRC(text); laActive = -2; laRowNodes = []; laLines.replaceChildren(); laLines.scrollTop = 0;
    laOffsetBar.hidden = !laParsed.timed;
    if (laParsed.timed) {
      laInfo.textContent = '点击歌词跳转 · 本机偏移：正数延后 / 负数提前';
      var fragment = document.createDocumentFragment();
      laParsed.lines.forEach(function (line) {
        var row = laEl('button', 'la-line', line.text || '♪'); row.type = 'button';
        row.addEventListener('click', function () {
          if (!laTrack() || laTrack().name !== laName || !Number.isFinite(audio.duration)) return;
          try { audio.currentTime = Math.max(0, Math.min(audio.duration, line.time + laLocalOffset)); laManualUntil = 0; laSyncLine(true); } catch (_) {}
        });
        fragment.appendChild(row); laRowNodes.push(row);
      });
      laLines.appendChild(fragment); laSyncLine(true);
    } else {
      laInfo.textContent = laParsed.plain.length ? '纯文本歌词 · 无时间轴' : '暂无歌词';
      laLines.appendChild(laEl('div', 'la-plain', laParsed.plain.length ? laParsed.plain.join('\\n\\n') : '让旋律继续流动\\n管理员可导入 .lrc 或粘贴歌词'));
    }
  }
  function laLoadTrack(force) {
    var track = laTrack(), name = track ? track.name : '';
    if (name === laName && !force) { laSyncLine(true); return; }
    laName = name; var epoch = ++laTrackEpoch;
    laLocalOffset = name ? laClampOffset(lsGet('r2m_lyric_offset:' + encodeURIComponent(name), '0')) : 0;
    laOffsetInput.value = String(laLocalOffset); laManualUntil = 0; laRenderLyrics('');
    if (!name) { laInfo.textContent = '选择歌曲后显示歌词'; return; }
    laInfo.textContent = '正在读取歌词…';
    laGetLyrics(name, !!force).then(function (value) {
      if (epoch !== laTrackEpoch || name !== laName) return;
      laRenderLyrics(value.lrc);
    }).catch(function () {
      if (epoch !== laTrackEpoch || name !== laName) return;
      laInfo.textContent = '歌词暂时不可用'; laLines.replaceChildren();
      laButton('重新读取歌词', function () { laLoadTrack(true); }, laLines);
    });
  }
  function laToggleLyrics() {
    if (!laTrack()) { toast('请先选择一首歌曲'); return; }
    if (!nowOpen) openNow();
    laLyricsVisible = !laLyricsVisible; nowPlayer.classList.toggle('la-lyrics-on', laLyricsVisible);
    if ($('laToggleLyrics')) { $('laToggleLyrics').textContent = laLyricsVisible ? '黑胶唱片' : '滚动歌词'; $('laToggleLyrics').setAttribute('aria-pressed', String(laLyricsVisible)); }
    $('nowDisc').setAttribute('aria-expanded', String(laLyricsVisible));
    laLoadTrack(false); laSyncLine(true);
  }
  var laDisc = $('nowDisc'); laDisc.tabIndex = 0; laDisc.setAttribute('role', 'button');
  laDisc.setAttribute('aria-label', '切换至滚动歌词'); laDisc.setAttribute('aria-controls', 'laLyrics'); laDisc.setAttribute('aria-expanded', 'false');
  laDisc.addEventListener('click', laToggleLyrics);
  laDisc.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); laToggleLyrics(); } });
  ['timeupdate', 'seeked', 'loadedmetadata'].forEach(function (type) { audio.addEventListener(type, function () { laSyncLine(type !== 'timeupdate'); }); });
  audio.addEventListener('emptied', function () { if (!playing) laLoadTrack(false); });
  function laField(parent, text, control) { var label = laEl('label', 'la-field', text); label.appendChild(control); parent.appendChild(label); return label; }
  function laTrackSelect(selected) {
    var select = laEl('select');
    Object.keys(map).filter(function (key) { return map[key] && typeof map[key].name === 'string'; }).sort(function (a, b) { return a.localeCompare(b, 'zh'); }).forEach(function (key) {
      var f = map[key], option = laEl('option', '', (f.title || f.name) + (f.artist ? ' · ' + f.artist : ''));
      option.value = f.name; select.appendChild(option);
    });
    if (selected && Array.from(select.options).some(function (option) { return option.value === selected; })) select.value = selected;
    return select;
  }
  function laOpenLyricsEditor() {
    if (!adminOn) { toast('请先登录管理员'); return; }
    var modal = laShowModal('管理歌词'), box = modal.box, select = laTrackSelect(playing), editor = laEl('textarea');
    editor.placeholder = '[00:12.50]这里是歌词\\n[00:18.200]支持多时间标签与纯文本'; editor.spellcheck = false;
    laField(box, '选择歌曲', select); laField(box, '歌词内容（UTF-8 / 最多 256 KiB）', editor);
    var status = laHint('请选择歌曲', box), actions = laEl('div', 'la-actions'), file = laEl('input');
    file.type = 'file'; file.accept = '.lrc,.txt,text/plain'; file.hidden = true; box.appendChild(file); box.appendChild(actions);
    var epoch = 0, busy = false;
    function enabled(on) { [editor, choose, save, remove, reload].forEach(function (el) { el.disabled = !on; }); }
    var choose = laButton('选择 .lrc 文件', function () { file.click(); }, actions);
    var reload = laButton('重新读取', function () { read(true); }, actions);
    var save = laButton('保存歌词', function () { write(false); }, actions); save.classList.add('la-primary');
    var remove = laButton('删除歌词', function () { if (window.confirm('删除所选歌曲的歌词？音频不会删除。')) write(true); }, actions); remove.classList.add('la-danger');
    function read(force) {
      var name = select.value, current = ++epoch; enabled(false); editor.value = '';
      if (!name) { status.textContent = '暂无歌曲，上传音乐后可添加歌词'; return; }
      status.textContent = '正在读取…';
      laGetLyrics(name, !!force).then(function (value) {
        if (current !== epoch || laModal !== modal) return;
        editor.value = value.lrc; status.textContent = value.lrc ? '可修改后保存；不会更改音频文件' : '尚无歌词，可选择文件或直接粘贴'; enabled(true);
      }).catch(function (error) {
        if (current !== epoch || laModal !== modal) return;
        status.textContent = error.message + '；请先重新读取，避免覆盖已有歌词'; reload.disabled = false;
      });
    }
    function write(deleting) {
      if (busy || !select.value || !adminOn) return;
      var name = select.value, text = editor.value;
      if (!deleting && new TextEncoder().encode(text).byteLength > 256 * 1024) { laError(new Error('歌词超过 256 KiB 上限')); return; }
      busy = true; enabled(false); select.disabled = true; status.textContent = '正在保存…'; ++epoch;
      laAdminJSON(deleting ? 'DELETE' : 'PUT', laLyricsURL(name), deleting ? undefined : text, deleting ? undefined : 'text/plain; charset=utf-8').then(function (value) {
        laCacheLyrics(name, value.lrc || '');
        if (name === laName) { laTrackEpoch++; laRenderLyrics(value.lrc || ''); }
        editor.value = value.lrc || ''; status.textContent = deleting ? '已删除歌词' : '已保存歌词'; toast(status.textContent);
      }).catch(function (error) { status.textContent = error.message; laError(error); }).finally(function () { busy = false; select.disabled = false; enabled(true); });
    }
    file.addEventListener('change', function () {
      var picked = file.files[0], name = select.value, current = ++epoch; file.value = '';
      if (!picked) return;
      if (picked.size > 256 * 1024) { laError(new Error('歌词文件超过 256 KiB')); return; }
      picked.arrayBuffer().then(function (buffer) {
        if (current !== epoch || select.value !== name || laModal !== modal) return;
        editor.value = new TextDecoder('utf-8', { fatal: true }).decode(buffer); status.textContent = '文件已载入，点击“保存歌词”生效';
      }).catch(function () { if (current === epoch) laError(new Error('请将歌词转换为 UTF-8 编码后重试')); });
    });
    editor.addEventListener('input', function () { ++epoch; });
    select.addEventListener('change', function () { if (!busy) read(false); }); read(false);
  }
  function laNormalizeAppearance(value) {
    var result = Object.assign({ albums: Object.create(null) }, laDefaults); value = value || {};
    Object.keys(laBounds).forEach(function (key) { var n = value[key], b = laBounds[key]; if (typeof n === 'number' && Number.isFinite(n) && n >= b[0] && n <= b[1]) result[key] = n; });
    if (value.albums && typeof value.albums === 'object') Object.keys(value.albums).forEach(function (name) { var version = value.albums[name]; if (Number.isSafeInteger(version) && version > 0) result.albums[name] = version; });
    return result;
  }
  function laFallbackBackground() { var track = laTrack(); return siteBackground || (track && track.cover) || ''; }
  function laSetBackgroundURL(url, custom) {
    laBackgroundURL = url; nowBg.style.backgroundImage = url ? 'url(' + JSON.stringify(url) + ')' : '';
    nowBg.classList.toggle('is-custom', !!custom);
  }
  function laApplyAppearance() {
    var current = Object.assign({}, laAppearance, laPreview || {}), root = document.documentElement;
    root.style.setProperty('--la-brightness', String(current.brightness)); root.style.setProperty('--la-blur', current.blur + 'px');
    root.style.setProperty('--la-disc-scale', String(current.discSize / 100)); root.style.setProperty('--la-spin', current.spinSeconds + 's');
    nowBg.style.inset = current.blur ? '-' + Math.ceil(current.blur * 2) + 'px' : '0';
    var track = laTrack(), album = track && (track.album || ''), version = track && laAppearance.albums[album];
    var url = version ? laAlbumURL(album, version) : '';
    if (!url || laBadBackgrounds.has(url)) { laSetBackgroundURL(laFallbackBackground(), !!siteBackground); return; }
    var unchanged = url === laBackgroundURL;
    // The host may have just overwritten backgroundImage before r2:background.
    laSetBackgroundURL(url, true);
    if (unchanged) return;
    var image = new Image(); image.onerror = function () {
      laBadBackgrounds.add(url); if (laBackgroundURL === url) laSetBackgroundURL(laFallbackBackground(), !!siteBackground);
    }; image.src = url;
  }
  function laAcceptAppearance(value) {
    ++laAppearanceEpoch; laAppearance = laNormalizeAppearance(value); laAppearanceReady = true; laApplyAppearance();
  }
  function laFetchAppearance(force) {
    if (laAppearancePending) return laAppearancePending;
    if (laAppearanceReady && !force) return Promise.resolve(laAppearance);
    var epoch = laAppearanceEpoch;
    laAppearancePending = fetch('/api/appearance', { cache: 'no-store' }).then(laJSON).then(function (value) {
      if (epoch === laAppearanceEpoch) laAcceptAppearance(value);
      return laAppearance;
    }).finally(function () { laAppearancePending = null; });
    return laAppearancePending;
  }
  function laOpenAppearance() {
    if (!adminOn) { toast('请先登录管理员'); return; }
    var modal = laShowModal('播放器外观', function () { laPreview = null; laApplyAppearance(); });
    var box = modal.box, status = laHint('正在读取全站设置…', box), controls = {}, dirty = {}, busy = false;
    laHint('滑块实时预览；点击保存后全站生效。关闭即放弃未保存预览，不改变主题、站点背景和其他设置。', box);
    var specs = [ ['brightness', '背景亮度', 0.01, function (n) { return Math.round(n * 100) + '%'; }], ['blur', '背景模糊', 1, function (n) { return n + ' px'; }], ['discSize', '唱片大小', 1, function (n) { return n + '%'; }], ['spinSeconds', '旋转一圈', 1, function (n) { return n + ' 秒'; }] ];
    specs.forEach(function (spec) {
      var key = spec[0], input = laEl('input'), label = laEl('label', 'la-field'), labelText = laEl('span');
      input.type = 'range'; input.min = String(laBounds[key][0]); input.max = String(laBounds[key][1]); input.step = String(spec[2]); input.disabled = true;
      label.appendChild(labelText); label.appendChild(input); box.appendChild(label);
      controls[key] = { input: input, update: function (value) { input.value = String(value); labelText.textContent = spec[1] + ' · ' + spec[3](value); } };
      controls[key].update(laAppearance[key]);
      input.addEventListener('input', function () { var value = Number(input.value); dirty[key] = value; laPreview = Object.assign({}, dirty); controls[key].update(value); laApplyAppearance(); });
    });
    var actions = laEl('div', 'la-actions'); box.appendChild(actions);
    var save = laButton('保存全站外观', function () {
      if (busy || !adminOn) return;
      if (!Object.keys(dirty).length) { toast('外观没有更改'); return; }
      setBusy(true); var patch = Object.assign({}, dirty);
      laAdminJSON('PUT', '/api/appearance', JSON.stringify(patch), 'application/json').then(function (value) {
        dirty = {}; if (laModal === modal) laPreview = null; laAcceptAppearance(value); fill(); status.textContent = '已保存，所有访客使用此外观'; toast('全站外观已保存');
      }).catch(function (error) { status.textContent = error.message; laError(error); }).finally(function () { setBusy(false); });
    }, actions); save.classList.add('la-primary');
    var reset = laButton('预览默认值', function () {
      dirty = Object.assign({}, laDefaults); laPreview = Object.assign({}, dirty); Object.keys(controls).forEach(function (key) { controls[key].update(dirty[key]); }); laApplyAppearance();
    }, actions);
    var refresh = laButton('重新读取', function () { loadSettings(true); }, actions);
    box.appendChild(laEl('h3', '', '专辑独立背景'));
    laHint('优先级：当前专辑背景 → 站点背景 → 当前歌曲封面。上传 / 恢复立即生效，不会保存上面的未提交滑块。', box);
    var albumSelect = laEl('select'), names = new Set();
    Object.keys(map).forEach(function (key) { var f = map[key]; if (f && typeof f.name === 'string') names.add(f.album || ''); });
    Array.from(names).sort(function (a, b) { return a.localeCompare(b, 'zh'); }).forEach(function (name) { var option = laEl('option', '', name || '未分类'); option.value = name; albumSelect.appendChild(option); });
    var currentTrack = laTrack(); if (currentTrack && names.has(currentTrack.album || '')) albumSelect.value = currentTrack.album || '';
    laField(box, '选择专辑', albumSelect);
    var preview = laEl('img', 'la-preview'); preview.alt = '所选专辑的独立背景预览'; preview.hidden = true; box.appendChild(preview);
    var albumInfo = laHint('', box), albumActions = laEl('div', 'la-actions'), file = laEl('input'); file.type = 'file'; file.accept = 'image/jpeg,image/png,image/webp,image/gif'; file.hidden = true;
    box.appendChild(file); box.appendChild(albumActions);
    var upload = laButton('上传专辑背景', function () { file.click(); }, albumActions);
    var restore = laButton('恢复默认背景', function () {
      if (busy || !adminOn || !names.size || !window.confirm('移除此专辑的独立背景？将恢复站点背景或歌曲封面。')) return;
      changeAlbum('DELETE');
    }, albumActions);
    function showAlbum() {
      var version = laAppearance.albums[albumSelect.value];
      preview.hidden = !version;
      if (version) preview.src = laAlbumURL(albumSelect.value, version); else preview.removeAttribute('src');
      albumInfo.textContent = !names.size ? '暂无专辑，请先上传音乐' : version ? '已启用专辑独立背景（jpg / png / webp / gif，最多 5 MiB）' : '未设置独立背景，当前使用站点背景或歌曲封面';
      restore.disabled = busy || !names.size || !version || !laAppearanceReady;
    }
    function setBusy(value) {
      busy = value; Object.keys(controls).forEach(function (key) { controls[key].input.disabled = value || !laAppearanceReady; });
      save.disabled = reset.disabled = value || !laAppearanceReady; refresh.disabled = value;
      albumSelect.disabled = upload.disabled = value || !names.size || !laAppearanceReady; showAlbum();
    }
    function fill() { Object.keys(controls).forEach(function (key) { controls[key].update(laOwn(dirty, key) ? dirty[key] : laAppearance[key]); }); showAlbum(); }
    function loadSettings(force) {
      setBusy(true); status.textContent = '正在读取全站设置…';
      laFetchAppearance(force).then(function () {
        if (laModal !== modal) return;
        dirty = {}; laPreview = null; fill(); laApplyAppearance(); status.textContent = '修改后可保存为全站默认';
      }).catch(function (error) { status.textContent = error.message + '；点击重新读取可重试'; }).finally(function () { setBusy(false); });
    }
    function changeAlbum(method, image) {
      var album = albumSelect.value; setBusy(true); albumInfo.textContent = '正在更新专辑背景…';
      laAdminJSON(method, laAlbumURL(album), image, image && image.type).then(function (value) {
        laBadBackgrounds.clear(); laAcceptAppearance(value); showAlbum(); toast(method === 'DELETE' ? '已恢复默认背景' : '专辑背景已保存');
      }).catch(laError).finally(function () { setBusy(false); });
    }
    file.addEventListener('change', function () {
      var image = file.files[0]; file.value = ''; if (!image || busy || !adminOn) return;
      if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].indexOf(image.type) < 0) { laError(new Error('仅支持 jpg/png/webp/gif')); return; }
      if (!image.size || image.size > 5 * 1024 * 1024) { laError(new Error('图片不能为空且不能超过 5 MiB')); return; }
      changeAlbum('PUT', image);
    });
    albumSelect.addEventListener('change', showAlbum); preview.addEventListener('error', function () { preview.hidden = true; }); loadSettings(false);
  }
  function laMountButtons() {
    var toolbar = $('plusToolbar'), extras = $('nowExtras');
    if (toolbar && !$('laOpenLyrics')) { var open = laButton('歌词 / 唱片', laToggleLyrics, toolbar); open.id = 'laOpenLyrics'; }
    if (extras && !$('laToggleLyrics')) { var toggleButton = laButton(laLyricsVisible ? '黑胶唱片' : '滚动歌词', laToggleLyrics, extras); toggleButton.id = 'laToggleLyrics'; toggleButton.setAttribute('aria-pressed', String(laLyricsVisible)); }
    [[toolbar, 'laEditLyrics', '管理歌词', laOpenLyricsEditor], [toolbar, 'laAppearance', '播放器外观', laOpenAppearance], [extras, 'laNowEditLyrics', '管理歌词', laOpenLyricsEditor], [extras, 'laNowAppearance', '外观', laOpenAppearance]].forEach(function (item) {
      if (!item[0]) return;
      var button = $(item[1]); if (!button) { button = laButton(item[2], item[3], item[0]); button.id = item[1]; }
      button.hidden = !adminOn;
    });
  }
  document.addEventListener('r2:loaded', function () {
    laCache.forEach(function (_, name) { if (!laOwn(map, name)) laCache.delete(name); });
    laMountButtons(); laLoadTrack(false); laApplyAppearance();
  });
  document.addEventListener('r2:track', function () { laLoadTrack(false); laApplyAppearance(); });
  document.addEventListener('r2:render', laMountButtons);
  document.addEventListener('r2:admin', function () { laMountButtons(); if (!adminOn && laModal) laModal.close(); });
  document.addEventListener('r2:background', laApplyAppearance);
  window.addEventListener('resize', function () { laSyncLine(true); });
  window.__r2LyricsAppearance = { parseLRC: laParseLRC, activeIndex: laActiveIndex, clampOffset: laClampOffset };
  laMountButtons(); laApplyAppearance(); laLoadTrack(false);
  // Empty lyrics and errors are cached per song; only an explicit retry/editor reload re-fetches.
  laFetchAppearance(false).catch(function () {});
})();


/* R2 Music v2 management; original dependency-free parser (no CDN).
 * Insert verbatim INSIDE the main browser IIFE, before setAdmin()/load().
 * Parser reads at most 12 MiB/file, one metadata block <=8 MiB, art <=5 MiB.
 */
var R2AudioInfo = (function () {
  var BLOCK=8*1024*1024, BUDGET=12*1024*1024, ART=5*1024*1024, TEXT=256*1024;
  function bad(){throw new Error('元信息损坏或超过安全读取上限')}
  function str(b,s,e){var a='';for(var i=s||0;i<(e==null?b.length:e);i++)a+=String.fromCharCode(b[i]);return a}
  function n32(b,p,le){if(p<0||p+4>b.length)bad();return new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(p,!!le)}
  function sync(b,p){if(p+4>b.length||(b[p]|b[p+1]|b[p+2]|b[p+3])&128)bad();return b[p]*2097152+b[p+1]*16384+b[p+2]*128+b[p+3]}
  function text(b,enc){
    if(b.length>TEXT)bad();
    var t=new TextDecoder(enc||'utf-8').decode(b);
    return t.replace(/\\u0000+/g,' / ').replace(/(?:\\s*\\/\\s*)+$/,'').trim().slice(0,200);
  }
  function idText(b,encoding){
    var e=['iso-8859-1','utf-16le','utf-16be','utf-8'][encoding];if(!e)return '';
    if(encoding===1&&b.length>=2){if(b[0]===254&&b[1]===255)e='utf-16be';if((b[0]===255&&b[1]===254)||(b[0]===254&&b[1]===255))b=b.subarray(2)}
    return text(b,e);
  }
  function unsync(b){var out=new Uint8Array(b.length),p=0;for(var i=0;i<b.length;i++){out[p++]=b[i];if(b[i]===255&&b[i+1]===0)i++}return out.subarray(0,p)}
  function picture(out,b,type){
    if(!b.length||b.length>ART||(out.cover&&type!==3)||out._front)return;
    var mime='';
    if(b[0]===255&&b[1]===216&&b[2]===255)mime='image/jpeg';
    else if(str(b,0,8)==='\\x89PNG\\r\\n\\x1a\\n')mime='image/png';
    else if(str(b,0,3)==='GIF')mime='image/gif';
    else if(str(b,0,4)==='RIFF'&&str(b,8,12)==='WEBP')mime='image/webp';
    if(mime){out.cover=new Blob([b],{type:mime});out._front=type===3}
  }
  function apic(out,b){
    if(b.length<5)return;var enc=b[0],p=1;
    while(p<b.length&&b[p])p++;if(p+2>b.length)return;
    p++;var type=b[p++],step=(enc===1||enc===2)?2:1,done=false;
    for(;p+step<=b.length;p+=step){if(b[p]===0&&(step===1||b[p+1]===0)){p+=step;done=true;break}}
    if(done)picture(out,b.subarray(p),type);
  }
  async function id3(read,file,out,head){
    if(str(head,0,3)==='ID3'){
      var ver=head[3];if(ver!==3&&ver!==4)throw new Error('仅支持 ID3v2.3 / 2.4');
      var size=sync(head,6);if(size>BLOCK||size+10>file.size)bad();
      var b=await read(10,size),p=0;
      if(ver===3&&(head[5]&128))b=unsync(b);
      if(head[5]&64){var ex=ver===3?n32(b,0)+4:sync(b,0);if(ex<6||ex>b.length)bad();p=ex}
      for(var count=0;p+10<=b.length&&count<4096;count++){
        var id=str(b,p,p+4);if(b[p]===0)break;if(!/^[A-Z0-9]{4}$/.test(id))bad();
        var len=ver===4?sync(b,p+4):n32(b,p+4),flags=b[p+9];p+=10;
        if(len>b.length-p)bad();var f=b.subarray(p,p+len);p+=len;
        if((ver===3&&(flags&192))||(ver===4&&(flags&12)))continue;
        if(ver===4&&((flags&2)||(head[5]&128)))f=unsync(f);
        if((ver===3&&(flags&32))||(ver===4&&(flags&64)))f=f.subarray(1);
        if(ver===4&&(flags&1))f=f.subarray(4);
        var key={TIT2:'title',TPE1:'artist',TALB:'album'}[id];
        if(key&&f.length>1&&!out[key])out[key]=idText(f.subarray(1),f[0]);
        else if(id==='APIC')apic(out,f);
      }
      out.format='ID3v2.'+ver;
    }
  }
  function flacPicture(out,b){
    var type=n32(b,0),p=4,l=n32(b,p);p+=4;
    if(l>b.length-p)bad();p+=l;l=n32(b,p);p+=4;if(l>b.length-p)bad();p+=l;
    p+=16;l=n32(b,p);p+=4;if(l>b.length-p)bad();picture(out,b.subarray(p,p+l),type);
  }
  function vorbis(out,b){
    var p=4,len=n32(b,0,true);if(len>b.length-p)bad();p+=len;
    var count=n32(b,p,true);p+=4;if(count>4096)bad();
    for(var i=0;i<count;i++){
      len=n32(b,p,true);p+=4;if(len>b.length-p)bad();var f=b.subarray(p,p+len);p+=len;
      if(len>TEXT)continue;var raw=new TextDecoder('utf-8').decode(f),eq=raw.indexOf('=');
      var key={TITLE:'title',ARTIST:'artist',ALBUM:'album'}[raw.slice(0,eq).toUpperCase()];
      if(key&&!out[key])out[key]=raw.slice(eq+1).replace(/\\u0000/g,'').trim().slice(0,200);
    }
  }
  async function flac(read,file,out){
    out.format='FLAC';var p=4;
    for(var i=0;i<128;i++){
      var h=await read(p,4),last=h[0]&128,type=h[0]&127,len=h[1]*65536+h[2]*256+h[3];p+=4;
      if(p+len>file.size)bad();
      if(type===4||type===6){var b=await read(p,len);if(type===4)vorbis(out,b);else flacPicture(out,b)}
      p+=len;if(last)return;
    }
    bad();
  }
  async function mp4(read,file,out){
    out.format='M4A / MP4';var boxes=0,albumArtist='';
    async function walk(start,end,depth,parent,item){
      if(depth>8)bad();var p=start;
      while(p+8<=end){
        if(++boxes>4096)bad();var h=await read(p,8),size=n32(h,0),kind=str(h,4,8),hs=8;
        if(size===1){var wide=await read(p+8,8);size=n32(wide,0)*4294967296+n32(wide,4);hs=16}
        else if(size===0)size=end-p;
        if(!Number.isSafeInteger(size)||size<hs||size>end-p)bad();
        var a=p+hs,z=p+size;
        if(kind==='moov'||kind==='udta'||kind==='ilst')await walk(a,z,depth+1,kind,'');
        else if(kind==='meta'){if(z-a<4)bad();await walk(a+4,z,depth+1,kind,'')}
        else if(parent==='ilst'&&['\\xa9nam','\\xa9ART','aART','\\xa9alb','covr'].indexOf(kind)>=0)await walk(a,z,depth+1,kind,kind);
        else if(kind==='data'&&item){
          if(z-a<8)bad();var info=await read(a,8),dtype=n32(info,0)&0xffffff,len=z-a-8;
          if(item==='covr'){if(len<=ART)picture(out,await read(a+8,len),3)}
          else if(len<=TEXT&&(dtype===1||dtype===2)){
            var value=text(await read(a+8,len),dtype===2?'utf-16be':'utf-8');
            var key={'\\xa9nam':'title','\\xa9ART':'artist','\\xa9alb':'album'}[item];
            if(key&&!out[key])out[key]=value;else if(item==='aART')albumArtist=value;
          }
        }
        p=z;
      }
      if(p!==end)bad();
    }
    await walk(0,file.size,0,'','');if(!out.artist)out.artist=albumArtist;
  }
  async function extract(file){
    var used=0,out={title:'',artist:'',album:'',cover:null,format:'未知',warnings:[]};
    async function read(start,len){
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(len)||start<0||len<0||len>BLOCK||start+len>file.size||used+len>BUDGET)bad();
      used+=len;var b=new Uint8Array(await file.slice(start,start+len).arrayBuffer());if(b.length!==len)bad();return b;
    }
    var mp3=/\\.mp3$/i.test(file.name||'');
    try{
      var h=await read(0,Math.min(12,file.size));
      if(str(h,0,3)==='ID3'){mp3=true;await id3(read,file,out,h)}
      else if(str(h,0,4)==='fLaC')await flac(read,file,out);
      else if(str(h,4,8)==='ftyp'||/\\.(m4a|mp4)$/i.test(file.name||''))await mp4(read,file,out);
    }catch(e){out.warnings.push(e.message||'读取失败')}
    if(mp3&&file.size>=128){try{
      var b=await read(file.size-128,128);
      if(str(b,0,3)==='TAG'){
        [['title',3],['artist',33],['album',63]].forEach(function(k){if(!out[k[0]])out[k[0]]=text(b.subarray(k[1],k[1]+30),'iso-8859-1')});
        if(out.format==='未知')out.format='ID3v1';
      }
    }catch(e){out.warnings.push(e.message||'ID3v1 读取失败')}}
    delete out._front;out.recognized=!!(out.title||out.artist||out.album||out.cover);out.bytesRead=used;return out;
  }
  return {extract:extract,limits:{block:BLOCK,total:BUDGET,cover:ART,text:TEXT}};
})();

(function () {
  var selected=new Set(), selecting=false, batchBusy=false, uploadBusy=false, stopBatch=false, stopUpload=false;
  var uploadQueue=[],dragName='',activeDialog=null;
  function el(tag,text,parent){var n=document.createElement(tag);if(text!=null)n.textContent=text;if(parent)parent.appendChild(n);return n}
  function button(text,parent,fn){var b=el('button',text,parent);b.type='button';if(fn)b.addEventListener('click',fn);return b}
  var style=el('style',null,document.head);
  style.textContent=[
    '.rm-tools{width:100%;margin:8px 0;color:var(--txt);font-size:13px}',
    '.rm-row{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin:7px 0}',
    '.rm-tools button,.rm-dialog button,.rm-grip{min-height:44px;padding:8px 12px;border:1px solid var(--hair);border-radius:10px;background:var(--panel2);color:var(--txt);font:inherit;cursor:pointer}',
    '.rm-tools button:disabled,.rm-dialog button:disabled{opacity:.45;cursor:default}',
    '.rm-tools [hidden],.rm-dialog [hidden]{display:none!important}',
    '.rm-status{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--sub);line-height:1.6}',
    '.rm-select{display:flex;align-items:center;justify-content:center;flex:0 0 40px;min-height:44px;cursor:pointer}.rm-select input{width:20px;height:20px;accent-color:var(--acc)}',
    '.track.rm-selected{outline:1px solid var(--acc)}.track.rm-over{outline:2px dashed var(--acc)}',
    '.rm-grip{flex:0 0 40px;padding:4px;cursor:grab;touch-action:pan-y}',
    'body.reorder .track{flex-wrap:wrap}body.reorder .track .mv{display:flex;flex-basis:100%;justify-content:flex-end}body.reorder .track .mv button{min-height:44px;min-width:44px}',
    '.rm-dialog{color:var(--txt);background:var(--panel);border:1px solid var(--hair);border-radius:18px;padding:18px;width:calc(100% - 28px);max-width:520px;max-height:85vh;max-height:85dvh;overflow:auto;box-sizing:border-box;z-index:10000}',
    '.rm-dialog::backdrop{background:rgba(0,0,0,.65)}.rm-dialog h3{margin:0 0 14px}.rm-dialog p{line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.rm-dialog label{display:flex;align-items:center;gap:8px;min-height:44px}.rm-dialog input[type=text]{box-sizing:border-box;width:100%;font-size:16px;padding:12px;color:var(--txt);background:var(--panel2);border:1px solid var(--hair);border-radius:9px}',
    '.rm-danger{color:var(--err)!important}.rm-now{font-size:12px;min-height:44px;border:0;background:transparent;color:inherit;padding:8px}'
  ].join('\\n');
  var host=$('plusToolbar')||upStrip.parentNode, root=el('section',null,host);root.className='rm-tools';root.setAttribute('aria-label','批量歌曲管理');
  var mainRow=el('div',null,root);mainRow.className='rm-row';
  var toggleBtn=button('批量管理',mainRow,function(){selecting=!selecting;syncUI()});
  var counter=el('span','',mainRow), actions=el('div',null,root);actions.className='rm-row';
  var allBtn=button('全选当前',actions,function(){visibleNames().forEach(function(n){selected.add(n)});syncUI()});
  var libraryBtn=button('全选全部',actions,function(){list.forEach(function(f){selected.add(f.name)});syncUI()});
  var clearBtn=button('清空选择',actions,function(){selected.clear();syncUI()});
  var metaBtn=button('批量改歌手 / 专辑',actions,function(){editBatch().catch(showError)});
  var deleteBtn=button('批量删除',actions,function(){deleteBatch().catch(showError)});deleteBtn.className='rm-danger';
  var hint=el('div','',root);hint.className='rm-status';
  var status=el('div','',root);status.className='rm-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  var cancelBtn=button('停止后续上传',root,function(){stopUpload=true;stopBatch=true;cancelBtn.disabled=true;cancelBtn.textContent='将在当前项目完成后停止'});cancelBtn.hidden=true;
  var nowHost=$('nowExtras'),nowBtn=nowHost?button('批量管理',nowHost,function(){if(typeof closeNow==='function')closeNow();selecting=true;syncUI();root.scrollIntoView({block:'center'})}):null;
  if(nowBtn)nowBtn.className='rm-now';
  function showError(e){toast(e.message||'操作失败',1)}
  function busy(){return batchBusy||uploadBusy}
  function syncUI(){
    root.hidden=!adminOn;if(nowBtn)nowBtn.hidden=!adminOn;
    if(!adminOn){selecting=false;selected.clear();if(activeDialog)activeDialog.close();}
    toggleBtn.textContent=selecting?'退出多选':'批量管理';toggleBtn.disabled=busy()||reorderOn;
    counter.textContent=selecting?'已选 '+selected.size+' 首（跨筛选保留）':'';
    actions.hidden=!selecting;hint.hidden=!(selecting||reorderOn);
    hint.textContent=reorderOn?'电脑拖动 ↕ 调整顺序；触屏使用置顶 / 上移 / 下移。完成后点原「保存」，取消不改变已有顺序。':'全选当前按搜索/专辑内歌曲选择；跨筛选保留选中，批处理每次 200 首，可停止后续。';
    [allBtn,libraryBtn,clearBtn].forEach(function(b){b.disabled=busy()||reorderOn});
    metaBtn.disabled=deleteBtn.disabled=busy()||reorderOn||!selected.size;
    if(nowBtn)nowBtn.disabled=busy()||reorderOn;
    btnReorder.disabled=busy();
    cancelBtn.hidden=!busy();
    if(!busy()){cancelBtn.disabled=false;cancelBtn.textContent='停止后续上传'}
    listEl.querySelectorAll('.track').forEach(function(row){
      var name=row.getAttribute('data-name'),check=row.querySelector('.rm-select'),grip=row.querySelector('.rm-grip');
      row.classList.toggle('rm-selected',selecting&&selected.has(name));
      if(selecting&&!reorderOn&&adminOn){
        if(!check){check=el('label');check.className='rm-select';var input=el('input',null,check);input.type='checkbox';input.setAttribute('aria-label','选择 '+name);check.addEventListener('click',function(e){e.stopPropagation()});input.addEventListener('change',function(){if(input.checked)selected.add(name);else selected.delete(name);syncUI()});row.insertBefore(check,row.firstChild)}
        check.firstChild.checked=selected.has(name);check.firstChild.disabled=busy();
      }else if(check)check.remove();
      row.draggable=!!reorderOn;
      if(reorderOn){if(!grip){grip=button('↕',null,function(e){e.stopPropagation()});grip.className='rm-grip';grip.title='鼠标拖动歌曲；触屏使用下方上移/下移';grip.setAttribute('aria-label',grip.title);row.insertBefore(grip,row.firstChild)}}
      else if(grip)grip.remove();
    });
  }
  document.addEventListener('r2:render',syncUI);
  document.addEventListener('r2:admin',syncUI);
  document.addEventListener('r2:loaded',function(){var names=new Set(list.map(function(f){return f.name}));selected.forEach(function(n){if(!names.has(n))selected.delete(n)});syncUI()});
  listEl.addEventListener('dragstart',function(e){
    var row=e.target.closest('.track');if(!reorderOn||!row)return;
    dragName=row.getAttribute('data-name');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',dragName);e.stopPropagation();
  });
  listEl.addEventListener('dragover',function(e){if(!reorderOn||!dragName)return;e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='move';var row=e.target.closest('.track');listEl.querySelectorAll('.rm-over').forEach(function(n){n.classList.remove('rm-over')});if(row)row.classList.add('rm-over')});
  listEl.addEventListener('drop',function(e){
    if(!reorderOn||!dragName)return;e.preventDefault();e.stopPropagation();
    var row=e.target.closest('.track'),from=workOrder.indexOf(dragName),to=row?workOrder.indexOf(row.getAttribute('data-name')):-1;
    if(from>=0&&to>=0&&from!==to){workOrder.splice(from,1);workOrder.splice(to,0,dragName);renderTracks()}
    dragName='';listEl.querySelectorAll('.rm-over').forEach(function(n){n.classList.remove('rm-over')});
  });
  listEl.addEventListener('dragend',function(){dragName='';upStrip.classList.remove('drag');listEl.querySelectorAll('.rm-over').forEach(function(n){n.classList.remove('rm-over')})});
  function dialog(title,build,choices){
    return new Promise(function(resolve){
      var d=el('dialog',null,document.body);d.className='rm-dialog';activeDialog=d;var heading=el('h3',title,d);heading.id='rm-dialog-title';d.setAttribute('aria-labelledby',heading.id);
      var content=el('div',null,d),controls=el('div',null,d),result=null;controls.className='rm-row';
      var state=build(content)||{};
      choices.forEach(function(c){var b=button(c.text,controls,function(){if(state.validate&&!state.validate(c.value))return;result={choice:c.value,data:state.value?state.value():null};d.close()});if(c.danger)b.className='rm-danger'});
      d.addEventListener('close',function(){if(activeDialog===d)activeDialog=null;d.remove();resolve(result);if(uploadQueue.length)setTimeout(pumpUploads,0)},{once:true});
      d.showModal();var first=d.querySelector('input,button');if(first)first.focus();
    });
  }
  function summaryNames(names){return names.slice(0,8).join('\\n')+(names.length>8?'\\n… 另 '+(names.length-8)+' 首':'')}
  async function editBatch(){
    if(busy()||!selected.size)return;var names=Array.from(selected);
    var answer=await dialog('批量修改：预览后确认',function(box){
      el('p','未勾选的字段保持原值；勾选后留空表示清空。歌名、封面及其他信息不变。',box);
      var edits={};['artist','album'].forEach(function(k){var label=el('label',null,box),c=el('input',null,label);c.type='checkbox';el('span',k==='artist'?'修改歌手':'修改专辑',label);var input=el('input',null,box);input.type='text';input.maxLength=200;input.disabled=true;input.setAttribute('aria-label',k==='artist'?'新歌手':'新专辑');edits[k]={check:c,input:input};c.onchange=function(){input.disabled=!c.checked;preview()};input.oninput=preview});
      var p=el('p','',box);
      function fields(){var f={};Object.keys(edits).forEach(function(k){if(edits[k].check.checked)f[k]=edits[k].input.value.trim()});return f}
      function preview(){var f=fields(),keys=Object.keys(f),count=names.filter(function(n){return map[n]&&keys.some(function(k){return (map[n][k]||'')!==f[k]})}).length;p.textContent='选中 '+names.length+' 首，预计实际修改 '+count+' 首。'+(!keys.length?'请先勾选字段。':'');return count}
      preview();return {value:fields,validate:function(v){if(v!=='apply')return true;if(!Object.keys(fields()).length){toast('请先勾选要修改的字段',1);return false}return true}};
    },[{text:'取消',value:'cancel'},{text:'查看确认',value:'apply'}]);
    if(!answer||answer.choice!=='apply'||busy())return;
    var fields=answer.data,yes=await dialog('确认批量修改 '+names.length+' 首',function(box){el('p',Object.keys(fields).map(function(k){return (k==='artist'?'歌手':'专辑')+' → '+(fields[k]||'（清空）')}).join('\\n')+'\\n\\n'+summaryNames(names),box)},[{text:'取消',value:'cancel'},{text:'确认修改',value:'yes'}]);
    if(yes&&yes.choice==='yes')await runBatch('meta',names,fields);
  }
  async function deleteBatch(){
    if(busy()||!selected.size)return;var names=Array.from(selected);
    var answer=await dialog('永久删除 '+names.length+' 首？',function(box){el('p','将删除选中歌曲的音频、封面、歌词和索引记录，无法撤销。站点设置和背景不会删除。\\n\\n'+summaryNames(names),box)},[{text:'取消',value:'cancel'},{text:'确认永久删除 '+names.length+' 首',value:'yes',danger:true}]);
    if(answer&&answer.choice==='yes')await runBatch('delete',names);
  }
  async function runBatch(action,names,fields){
    if(busy()||!adminOn)return;batchBusy=true;stopBatch=false;cancelBtn.disabled=false;cancelBtn.textContent='停止后续批次（当前批次会完成）';syncUI();
    var done=0,changed=0,failed=[],processed=0;
    try {
      for(var i=0;i<names.length&&!stopBatch;){
        var part=names.slice(i,i+200);
        while(part.length>1&&new TextEncoder().encode(JSON.stringify({action:action,names:part,fields:fields})).length>64000)part.pop();
        status.textContent='处理中 '+(i+1)+'–'+(i+part.length)+' / '+names.length;
        var data=await (await api('POST','/api/batch',JSON.stringify({action:action,names:part,fields:fields}),'application/json')).json();
        var good=data.succeeded||[];done+=good.length;changed+=data.changed||0;failed=failed.concat(data.failed||[]);processed+=part.length;i+=part.length;
        good.forEach(function(n){selected.delete(n)});
        if(action==='delete'&&(data.deletedAudio||good).indexOf(playing)>=0&&typeof stopPlayback==='function')stopPlayback();
      }
      status.textContent='批量'+(action==='delete'?'删除':'修改')+'：成功 '+done+' 首，失败 '+failed.length+' 首，未处理 '+(names.length-processed)+' 首。'+(action==='meta'?'实际修改 '+changed+' 首。':'非多对象事务，失败项可能已有部分附属文件删除。')+(failed.length?'\\n失败记录：\\n'+failed.map(function(f){return f.name+'：'+f.error}).join('\\n'):'');
    }catch(e){status.textContent='处理已中断：'+e.message+'。已确认成功 '+done+' 首；当前批次结果可能不确定，请刷新后核对，不会自动重试。'}
    finally{batchBusy=false;syncUI();load();if(uploadQueue.length)pumpUploads()}
  }
  function normalTitle(v){var s=String(v||'');try{s=s.normalize('NFKC')}catch(e){}return s.toLowerCase().replace(/\\.[a-z0-9]{2,5}$/i,'').replace(/[\\s._\\-()[\\]{}'"，。！？、·]/g,'')}
  function uploadOne(file,position,total,prog){
    return new Promise(function(resolve,reject){
      var xhr=new XMLHttpRequest();xhr.open('POST','/api/upload?name='+encodeURIComponent(file.name),true);xhr.timeout=180000;
      xhr.setRequestHeader('Authorization','Bearer '+token);
      xhr.upload.onprogress=function(e){if(e.lengthComputable){var pct=Math.round(e.loaded/e.total*100);prog.firstElementChild.style.width=pct+'%';status.textContent='上传 '+position+' / '+total+'：'+file.name+' · '+pct+'%'}};
      xhr.onload=function(){if(xhr.status>=200&&xhr.status<300)resolve();else{var msg='HTTP '+xhr.status;try{msg=JSON.parse(xhr.responseText).error||msg}catch(e){}reject(new Error(msg))}};
      xhr.onerror=function(){reject(new Error('网络错误；服务器结果可能不确定'))};xhr.ontimeout=function(){reject(new Error('上传超时；服务器结果可能不确定'))};xhr.onabort=function(){reject(new Error('上传中断'))};xhr.send(file);
    });
  }
  function compressCover(blob){return new Promise(function(resolve){var done=false;var t=setTimeout(function(){if(!done){done=true;resolve(null)}},20000);try{shrink(blob,function(b){if(done)return;done=true;clearTimeout(t);resolve(b&&b.size<=5*1024*1024?b:null)})}catch(e){clearTimeout(t);resolve(null)}})}
  async function pumpUploads(){
    if(busy()||activeDialog||!uploadQueue.length)return;
    uploadBusy=true;stopUpload=false;cancelBtn.disabled=false;cancelBtn.textContent='停止后续上传（当前文件会完成）';syncUI();
    var ok=0,fail=0,skip=0,recognized=0,manual=0,extras=[],unprocessed=0;
    var prog=upStrip.querySelector('.u-progress'),label=upStrip.querySelector('.u-txt');label.style.display='none';prog.style.display='block';
    try {
      while(uploadQueue.length&&!stopUpload){
        var files=uploadQueue.shift(),known=new Map(),seen=new Set(),i=0;
        // A fresh public listing prevents silently overwriting files uploaded elsewhere.
        var response=await fetch('/api/list',{cache:'no-store'});if(!response.ok)throw new Error('无法取得最新文件列表，已停止上传以免误覆盖');
        var fresh=await response.json();if(!Array.isArray(fresh.files))throw new Error('文件列表无效，已停止上传');
        fresh.files.forEach(function(f){known.set(f.name,f)});
        for(var i=0;i<files.length;i++){
          if(stopUpload){unprocessed+=files.length-i;break;}
          var file=files[i];prog.firstElementChild.style.width='0%';status.textContent='识别音频信息 '+(i+1)+' / '+files.length+'：'+file.name;
          if(!/\\.(mp3|m4a|flac|ogg|oga|wav|aac|opus|weba)$/i.test(file.name)||file.size>50*1024*1024||file.name.trim()!==file.name||/[\\\\/\\x00-\\x1f\\x7f]/.test(file.name)){fail++;extras.push(file.name+'：格式/文件名无效或超过 50 MiB');continue;}
          var info=await R2AudioInfo.extract(file),same=known.get(file.name),inBatch=seen.has(file.name),similar=null;
          seen.add(file.name);var nt=normalTitle(info.title||file.name);
          if(!same&&nt)known.forEach(function(f){if(!similar&&f.size===file.size&&normalTitle(f.title||f.name)===nt)similar=f});
          if(same||inBatch||similar){
            var decision=await dialog(same||inBatch?'检测到同名文件':'检测到疑似重复音频',function(box){el('p',file.name+'\\n'+(same?'服务器已有同名音频。覆盖仅替换音频；已填写信息和已有封面保留。':(inBatch?'本批此前已出现同名文件（可能已上传或跳过）。':'与 '+similar.name+' 的大小及规范化歌名一致；内容未做音频指纹验证。'))+'\\n请选择覆盖/继续、跳过，或取消后续上传。',box)},[{text:'跳过此文件',value:'skip'},{text:same||inBatch?'确认覆盖同名音频':'仍然上传（保留文件名）',value:'upload',danger:!!(same||inBatch)},{text:'取消后续上传',value:'cancel'}]);
            if(!decision||decision.choice==='cancel'){stopUpload=true;unprocessed+=files.length-i;break;}
            if(decision.choice==='skip'){skip++;continue;}
          }
          try{await uploadOne(file,i+1,files.length,prog)}catch(e){fail++;extras.push(file.name+'：'+e.message);continue;}
          ok++;if(info.recognized)recognized++;else manual++;
          var entry={name:file.name,size:file.size,title:info.title,artist:info.artist,album:info.album};known.set(file.name,entry);
          if(info.warnings.length)extras.push(file.name+'：标签部分不可读，已继续上传');
          if(info.recognized){try{
            var data=await (await api('POST','/api/meta-auto/'+encodeURIComponent(file.name),JSON.stringify({title:info.title,artist:info.artist,album:info.album}),'application/json')).json();
            if(data.meta)Object.assign(entry,data.meta);
            if(info.cover&&!data.hasCover){
              status.textContent='压缩并保存封面：'+file.name;
              var cover=await compressCover(info.cover);
              if(cover)await api('POST','/api/cover/'+encodeURIComponent(file.name)+'?auto=1',cover,cover.type||'image/jpeg');
              else extras.push(file.name+'：封面压缩失败/超时/过大，请手动选择封面');
            }
          }catch(e){extras.push(file.name+'：音频已上传，自动信息/封面保存失败：'+e.message)}}
        }
      }
    }catch(e){unprocessed+=files?files.length-i:0;extras.push(e.message||'上传队列中断')}
    finally{
      unprocessed+=uploadQueue.reduce(function(n,a){return n+a.length},0);uploadQueue=[];
      status.textContent='上传完成 '+ok+' 首 · 失败 '+fail+' · 跳过 '+skip+' · 未处理 '+unprocessed+'\\n'+recognized+' 首识别成功（可能仅部分字段） / '+manual+' 首待手动填写。仅补空字段，保留已填信息和已有封面。'+(extras.length?'\\n需留意：\\n'+extras.join('\\n'):'');
      prog.style.display='none';label.style.display='';uploadBusy=false;syncUI();if(ok)load();
      toast('上传 '+ok+' 首：识别 '+recognized+' / 待手动 '+manual+(extras.length?'，详情见管理栏':''),!ok&&fail?1:0);
    }
  }
  uploadFiles=function(files){
    var a=Array.prototype.slice.call(files||[]);if(!a.length)return;
    if(!adminOn){toast('请先进入管理模式',1);return;}
    if(reorderOn){toast('请先保存或取消整理顺序，再上传',1);return;}
    uploadQueue.push(a);if(busy()){toast('已加入上传队列，将串行处理');return;}pumpUploads();
  };
  syncUI();
})();


// 整合各扩展的紧凑工具栏，保持首页不被按钮挤满。
(function(){
  var style=document.createElement('style');style.id='r2PlusFinalStyle';style.textContent=\`
  #plusToolbar{gap:7px;margin:0 0 14px;align-items:center}
  #plusToolbar #r2lib-tools,#plusToolbar .rm-tools{display:contents}
  #plusToolbar .rm-tools>.rm-row:first-child{display:contents}
  #plusToolbar .rm-tools>.rm-row:first-child>span:empty{display:none}
  #plusToolbar button,#plusToolbar .la-button,#plusToolbar .r2lib-btn{height:34px;min-height:34px;line-height:1.2;padding:0 11px;font:600 12px -apple-system,BlinkMacSystemFont,sans-serif;border:1px solid var(--hair2);border-radius:10px;background:var(--panel);color:var(--sub);margin:0;box-sizing:border-box;white-space:nowrap;flex-shrink:0}
  #plusToolbar button:hover{color:var(--txt);border-color:var(--acc)}
  #plusToolbar [hidden]{display:none!important}
  #plusToolbar .rm-row:not(:first-child),#plusToolbar .rm-status:not(:empty),#plusToolbar .r2lib-resume{flex-basis:100%;width:100%;margin:2px 0 0}
  #plusToolbar .rm-status:empty{display:none}
  #plusToolbar .rm-status{max-height:180px;overflow:auto;font-size:11px;line-height:1.7}
  .track .r2lib-heart{width:32px;flex:0 0 32px;min-height:32px;height:32px;background:transparent;border:0;border-radius:9px;font-size:25px;padding:0}
  #nowExtras .r2lib-heart{width:36px;height:32px;flex:0 0 36px;min-height:32px;font-size:24px;padding:0;color:rgba(255,255,255,.8)}
  #nowExtras .r2lib-liked{color:#ff718b}
  #nowExtras{margin-top:10px;gap:6px}
  .now-inner{min-height:720px}.now-stage{padding-top:55px}
  .r2lib-resume span{font-size:12px}
  @media(max-height:740px){.now-inner{min-height:620px}.now-stage{padding-top:48px;min-height:225px}.now-deck{width:min(74vw,370px,41dvh)}}
  @media(max-width:360px){#plusToolbar button{font-size:11px;padding:0 9px}.track .r2lib-heart{width:28px;flex-basis:28px}.track .idx{width:24px;flex-basis:24px}.track .cv{width:30px;height:30px}.track .name{font-size:12.5px}}
  \`;document.head.appendChild(style);
})();


  setAdmin();syncPlayback();syncProgress();
  load();
  window.__r2m={play:play,askDel:askDel,openPlayer:openNow,closePlayer:closeNow};
})();
</script>
</body>
</html>`;


// 桌面应用资源，无额外绑定、无凭据缓存
const APP_ICONS={"192":"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","512":"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"};
const APP_SW="const CACHE='r2music-static-v2.0.0';\nconst STATIC=['/app-icon-192.png','/app-icon-512.png','/offline'];\nself.addEventListener('install',event=>{\n  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(STATIC)));\n});\nself.addEventListener('activate',event=>{\n  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('r2music-static-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));\n});\nself.addEventListener('message',event=>{\n  if(event.data&&event.data.type==='SKIP_WAITING')self.skipWaiting();\n});\nself.addEventListener('fetch',event=>{\n  const request=event.request,url=new URL(request.url);\n  if(request.method!=='GET'||url.origin!==self.location.origin)return;\n  // 不缓存歌曲、带令牌请求、管理接口、歌词或用户页面。\n  if(url.pathname.startsWith('/api/')||request.headers.has('authorization'))return;\n  if(request.mode==='navigate'){\n    event.respondWith(fetch(request).catch(()=>caches.match('/offline').then(cached=>cached||new Response('当前离线，请联网后重试',{headers:{'content-type':'text/plain;charset=utf-8'}}))));return;\n  }\n  if(STATIC.includes(url.pathname))event.respondWith(caches.match(url.pathname).then(cached=>cached||fetch(request)));\n});\n";
const APP_OFFLINE="<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\"><meta name=\"theme-color\" content=\"#090a0d\"><title>暂时离线</title><style>body{margin:0;min-height:100vh;display:grid;place-content:center;text-align:center;background:#090a0d;color:#eee;font:16px/1.8 system-ui;padding:24px;box-sizing:border-box}img{width:90px;border-radius:22px;margin:auto}p{color:#999;font-size:14px}a{color:#9ebaff}</style><img src=\"/app-icon-192.png\" alt=\"音乐\"><h2>暂时没有网络</h2><p>歌曲需要联网播放。<br>你的本机歌单和收藏仍保留。</p><a href=\"/\">联网后重新打开</a></html>";
async function routeApp(request,env,url){
 if(request.method!=='GET')return null;
 if(url.pathname==='/manifest.webmanifest'){
  const site=await readSite(env.MUSIC_BUCKET),name=String(site.name||DEFAULT_NAME).slice(0,30);
  return new Response(JSON.stringify({id:'/',name,short_name:name.slice(0,12),description:'私人音乐与黑胶播放器',lang:'zh-CN',start_url:'/?app=1',scope:'/',display:'standalone',background_color:'#090a0d',theme_color:'#090a0d',icons:[{src:'/app-icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},{src:'/app-icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]}),{headers:{'content-type':'application/manifest+json;charset=utf-8','cache-control':'no-cache'}});
 }
 if(url.pathname==='/sw.js')return new Response(APP_SW,{headers:{'content-type':'application/javascript;charset=utf-8','cache-control':'no-cache','service-worker-allowed':'/'}});
 if(url.pathname==='/offline')return new Response(APP_OFFLINE,{headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-cache'}});
 const m=url.pathname.match(/^\/app-icon-(192|512)\.png$/);
 if(m){const bytes=Uint8Array.from(atob(APP_ICONS[m[1]]),c=>c.charCodeAt(0));return new Response(bytes,{headers:{'content-type':'image/png','cache-control':'public,max-age=604800'}})}
 return null;
}


/* R2 Music: lyrics / appearance routes. Insert at Worker top level.
 * Within the existing router try block, BEFORE all other routes:
 * const laResponse = await routeLyricsAppearance(request, env, url);
 * if (laResponse) return laResponse;
 * PUT /api/lyrics?name=... accepts UTF-8 LRC text (or JSON {lrc}).
 * Appearance PATCH semantics use PUT; omitted fields/albums are preserved.
 */
const laLyricsMaxBytes = 256 * 1024;
const laImageMaxBytes = 5 * 1024 * 1024;
const laAppearanceKey = '_appearance.json';
const laDefaultAppearance = Object.freeze({ brightness: 0.78, blur: 24, discSize: 100, spinSeconds: 18 });
const laAppearanceBounds = { brightness: [0.2, 1], blur: [0, 40], discSize: [70, 100], spinSeconds: [10, 60] };
const laImageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const laAppearanceLocks = new WeakMap();
function laOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
function laObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
async function laReadAppearance(bucket) {
  const obj = await bucket.get(laAppearanceKey);
  if (!obj) return {};
  try { const value = await obj.json(); return laObject(value) ? value : {}; } catch (_) { return {}; }
}
function laAppearanceView(value) {
  const view = { ...laDefaultAppearance, albums: Object.create(null) };
  for (const key of Object.keys(laAppearanceBounds)) {
    const n = value[key], bounds = laAppearanceBounds[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= bounds[0] && n <= bounds[1]) view[key] = n;
  }
  if (laObject(value.albums)) {
    for (const name of Object.keys(value.albums)) {
      const version = value.albums[name];
      if (Number.isSafeInteger(version) && version > 0) view.albums[name] = version;
    }
  }
  return view;
}
// Serialize read/merge/write within this isolate. R2 is not a cross-isolate transaction store.
async function laUpdateAppearance(bucket, edit) {
  const previous = laAppearanceLocks.get(bucket) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const state = await laReadAppearance(bucket);
    await edit(state);
    await bucket.put(laAppearanceKey, JSON.stringify(state), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    return laAppearanceView(state);
  });
  laAppearanceLocks.set(bucket, pending);
  try { return await pending; }
  finally { if (laAppearanceLocks.get(bucket) === pending) laAppearanceLocks.delete(bucket); }
}
async function laAlbumKey(name) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name));
  return '_album-backgrounds/' + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('') + '.img';
}
function laImageSignature(bytes, type) {
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/png') return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b);
  if (type === 'image/gif') return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  return type === 'image/webp' && bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
}
function laMethodNotAllowed(allow) {
  const response = jsonRes({ error: '不支持的请求方法' }, 405);
  response.headers.set('Allow', allow);
  return response;
}
async function routeLyricsAppearance(request, env, url) {
  const path = url.pathname;
  if (!['/api/lyrics', '/api/appearance', '/api/album-background'].includes(path)) return null;
  const bucket = env.MUSIC_BUCKET, method = request.method;
  const allow = path === '/api/album-background' ? ['GET', 'PUT', 'POST', 'DELETE'] : path === '/api/lyrics' ? ['GET', 'PUT', 'DELETE'] : ['GET', 'PUT'];
  if (!allow.includes(method)) return laMethodNotAllowed(allow.join(', '));
  if (method !== 'GET' && !authorized(request, env)) return jsonRes({ error: '需要管理令牌' }, 401);
  if (path === '/api/lyrics') {
    const name = url.searchParams.get('name');
    if (!name || safeKey(name) !== name || /[\x00-\x1f\x7f]/.test(name) || !isAudio(name) || new TextEncoder().encode('_lyrics/' + name + '.json').byteLength > 1024) {
      return jsonRes({ error: '无效音频文件名' }, 400);
    }
    if (!await bucket.head(name)) return jsonRes({ error: '音频不存在' }, 404);
    const key = '_lyrics/' + name + '.json';
    if (method === 'GET') {
      const obj = await bucket.get(key);
      if (!obj) return jsonRes({ lrc: '' });
      let stored;
      try { stored = await obj.json(); } catch (_) { stored = {}; }
      return jsonRes({ lrc: stored && typeof stored.lrc === 'string' ? stored.lrc : '' });
    }
    if (method === 'DELETE') { await bucket.delete(key); return jsonRes({ lrc: '' }); }
    const bytes = await readLimitedBody(request.body, laLyricsMaxBytes);
    if (!bytes) return jsonRes({ error: '歌词超过 256 KiB 上限' }, 413);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_) { return jsonRes({ error: '歌词必须使用 UTF-8 编码' }, 400); }
    if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() === 'application/json') {
      try { const data = JSON.parse(text); text = data && data.lrc; }
      catch (_) { return jsonRes({ error: '请求体不是有效 JSON' }, 400); }
    }
    if (typeof text !== 'string') return jsonRes({ error: 'lrc 必须是字符串' }, 400);
    await bucket.put(key, JSON.stringify({ lrc: text }), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    return jsonRes({ lrc: text });
  }
  if (path === '/api/appearance') {
    if (method === 'GET') return jsonRes(laAppearanceView(await laReadAppearance(bucket)));
    const bytes = await readLimitedBody(request.body, 16 * 1024);
    if (!bytes) return jsonRes({ error: '设置请求过大' }, 413);
    let patch;
    try { patch = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch (_) { return jsonRes({ error: '请求体不是有效 UTF-8 JSON' }, 400); }
    if (!laObject(patch)) return jsonRes({ error: '设置必须是 JSON 对象' }, 400);
    for (const key of Object.keys(patch)) {
      const bounds = laOwn(laAppearanceBounds, key) && laAppearanceBounds[key];
      if (!bounds || typeof patch[key] !== 'number' || !Number.isFinite(patch[key]) || patch[key] < bounds[0] || patch[key] > bounds[1]) {
        return jsonRes({ error: '无效外观设置: ' + key }, 400);
      }
    }
    return jsonRes(await laUpdateAppearance(bucket, state => { for (const key of Object.keys(patch)) state[key] = patch[key]; }));
  }
  const album = url.searchParams.get('album');
  if (album === null || /[\x00-\x1f\x7f]/.test(album) || new TextEncoder().encode(album).byteLength > 1024) {
    return jsonRes({ error: '无效专辑名称' }, 400);
  }
  const key = await laAlbumKey(album);
  if (method === 'GET') {
    const state = laAppearanceView(await laReadAppearance(bucket));
    if (!laOwn(state.albums, album)) return jsonRes({ error: '此专辑未设置背景' }, 404);
    const obj = await bucket.get(key);
    if (!obj) return jsonRes({ error: '此专辑未设置背景' }, 404);
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    if (!laImageTypes.includes(headers.get('content-type'))) return jsonRes({ error: '无效背景图片' }, 415);
    headers.set('X-Content-Type-Options', 'nosniff');
    if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
    // A stable hashed key can change: revalidate instead of immutable caching of old version URLs.
    headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return new Response(obj.body, { headers });
  }
  if (method === 'DELETE') {
    const result = await laUpdateAppearance(bucket, async state => {
      if (laObject(state.albums)) delete state.albums[album];
      await bucket.delete(key);
    });
    return jsonRes(result);
  }
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!laImageTypes.includes(type)) return jsonRes({ error: '背景仅支持 jpg/png/webp/gif' }, 415);
  const bytes = await readLimitedBody(request.body, laImageMaxBytes);
  if (!bytes) return jsonRes({ error: '背景超过 5 MiB 上限' }, 413);
  if (!laImageSignature(bytes, type)) return jsonRes({ error: '图片内容与类型不符或为空' }, 400);
  const result = await laUpdateAppearance(bucket, async state => {
    await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
    const albums = Object.assign(Object.create(null), laObject(state.albums) ? state.albums : {});
    const previous = Number(albums[album]);
    albums[album] = Math.max(Date.now(), Number.isSafeInteger(previous) && previous > 0 ? previous + 1 : 0);
    state.albums = albums;
  });
  return jsonRes(result);
}


/* R2 Music v2: top-level fragment. Call routeManage BEFORE legacy API routes.
 * No transaction across R2 objects. Failed items remain explicit in the response.
 * Lyrics convention: lyricKey/lyricsKey helper if supplied, else _lyrics/<name>.json.
 */
async function routeManage(request, env, url) {
  const path=url.pathname, batch=path==='/api/batch', auto=path.startsWith('/api/meta-auto/');
  const autoCover=path.startsWith('/api/cover/')&&url.searchParams.get('auto')==='1';
  if(!batch&&!auto&&!autoCover)return null;
  if(request.method!=='POST')return jsonRes({error:'仅支持 POST'},405);
  if(!authorized(request,env))return jsonRes({error:'需要管理令牌'},401);
  const bucket=env.MUSIC_BUCKET, limit=autoCover?5*1024*1024:(batch?65536:4096);
  let bytes, body;
  try { bytes=await readLimitedBody(request.body,limit); }
  catch(e) { return jsonRes({error:'读取请求失败'},400); }
  if(bytes===null)return jsonRes({error:'请求体超过 '+limit+' 字节'},413);
  if(!autoCover){
    try { body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
    catch(e) { return jsonRes({error:'请求体不是有效 UTF-8 JSON'},400); }
    if(!body||typeof body!=='object'||Array.isArray(body))return jsonRes({error:'参数无效'},400);
  }
  const valid=(n)=>typeof n==='string'&&n.length>0&&safeKey(n)===n&&!/[\x00-\x1f\x7f]/.test(n)&&new TextEncoder().encode(n).length<=1024&&isAudio(n);
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const clean=(v)=>v.trim().slice(0,200);
  const record=(idx,n)=>own(idx,n)&&idx[n]&&typeof idx[n]==='object'&&!Array.isArray(idx[n])?idx[n]:{};
  if(autoCover){
    let name;try{name=decodeURIComponent(path.slice('/api/cover/'.length));}catch(e){return jsonRes({error:'文件名编码无效'},400);}
    if(!valid(name))return jsonRes({error:'文件名无效'},400);
    const ct=(request.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(!COVER_TYPES.includes(ct)||!bytes.length)return jsonRes({error:'封面格式无效'},400);
    try{
      if(!(await bucket.head(name)))return jsonRes({error:'音频不存在'},404);
      let idx=await readIndex(bucket);
      if(record(idx,name).cv||await bucket.head(coverKey(name)))return jsonRes({ok:true,skipped:true,hasCover:true});
      // Conditional R2 put protects an image written after the existence check.
      const saved=await bucket.put(coverKey(name),bytes,{httpMetadata:{contentType:ct},onlyIf:{etagDoesNotMatch:'*'}});
      if(!saved)return jsonRes({ok:true,skipped:true,hasCover:true});
      // Re-read rather than persisting the pre-upload metadata snapshot.
      idx=await readIndex(bucket);const meta=Object.assign({},record(idx,name));
      if(!meta.cv){meta.cv=Date.now();idx[name]=meta;await writeIndex(bucket,idx);}
      return jsonRes({ok:true,skipped:false,hasCover:true});
    }catch(e){return jsonRes({error:'自动封面保存失败；音频不受影响'},500);}
  }
  if(auto){
    let name;
    try { name=decodeURIComponent(path.slice('/api/meta-auto/'.length)); }
    catch(e) { return jsonRes({error:'文件名编码无效'},400); }
    if(!valid(name))return jsonRes({error:'文件名无效'},400);
    const keys=Object.keys(body);
    if(keys.some(k=>!['title','artist','album'].includes(k)||typeof body[k]!=='string'||body[k].length>200))return jsonRes({error:'只接受 200 字以内的 title/artist/album 文本'},400);
    try {
      if(!(await bucket.head(name)))return jsonRes({error:'音频不存在'},404);
      const idx=await readIndex(bucket), meta=Object.assign({},record(idx,name));let changed=false;
      for(const k of keys){
        const v=clean(body[k]);
        if(v&&(meta[k]==null||String(meta[k]).trim()==='')){meta[k]=v;changed=true;}
      }
      // A cover may exist even if an earlier index write failed: do not overwrite it.
      const hasCover=!!meta.cv||!!(await bucket.head(coverKey(name)));
      if(changed){idx[name]=meta;await writeIndex(bucket,idx);}
      return jsonRes({ok:true,name,meta,hasCover,changed});
    } catch(e) { return jsonRes({error:'自动元数据保存失败，请重试'},500); }
  }
  if(!['meta','delete'].includes(body.action)||!Array.isArray(body.names)||!body.names.length||body.names.length>200||body.names.some(n=>!valid(n)))return jsonRes({error:'action 或 names 无效；一次限 1–200 个合法音频文件名'},400);
  const names=Array.from(new Set(body.names)), fields=body.fields;
  if(body.action==='meta'&&(!fields||typeof fields!=='object'||Array.isArray(fields)||!Object.keys(fields).length||Object.keys(fields).some(k=>!['artist','album'].includes(k)||typeof fields[k]!=='string'||fields[k].length>200)))return jsonRes({error:'fields 只接受 200 字以内的 artist/album 文本，空文本表示清空'},400);
  let idx,ord;
  try { idx=await readIndex(bucket); if(body.action==='delete')ord=await readOrder(bucket); }
  catch(e) { return jsonRes({error:'读取索引失败，未执行批处理'},500); }
  const succeeded=[],failed=[],changedNames=[],deleted=[];
  for(const name of names){
    let stage='head';
    try {
      if(!(await bucket.head(name))){failed.push({name,stage,error:'音频不存在'});continue;}
      if(body.action==='meta'){
        const next=Object.assign({},record(idx,name));let changed=false;
        for(const k of Object.keys(fields)){const v=clean(fields[k]);if((next[k]==null?'':String(next[k]))!==v){next[k]=v;changed=true;}}
        if(changed){idx[name]=next;changedNames.push(name);}
        succeeded.push(name);
      }else{
        // Delete audio last: an ancillary-object failure keeps playable audio + index.
        stage='cover';await bucket.delete(coverKey(name));
        stage='lyrics';
        const lk=typeof lyricKey==='function'?lyricKey(name):(typeof lyricsKey==='function'?lyricsKey(name):'_lyrics/'+name+'.json');
        // Never let an incompatible helper touch site/background/order objects.
        if(typeof lk!=='string'||!lk.startsWith('_lyrics/'))throw new Error('歌词存储键不兼容');
        await bucket.delete(lk);
        stage='audio';await bucket.delete(name);
        delete idx[name];deleted.push(name);succeeded.push(name);
      }
    }catch(e){failed.push({name,stage,error:'R2 '+stage+' 操作失败；可能已删除部分附属文件',audioDeleted:stage==='audio'?null:false});}
  }
  let indexSaved=false,orderSaved=body.action!=='delete';
  try {
    if(changedNames.length||deleted.length){await writeIndex(bucket,idx);indexSaved=true;}
    if(deleted.length){
      const gone=new Set(deleted);
      await bucket.put(ORDER_KEY,JSON.stringify(ord.filter(n=>!gone.has(n))),{httpMetadata:{contentType:'application/json'}});
      orderSaved=true;
    }else orderSaved=true;
  } catch(e) {
    const affected=new Set(body.action==='meta'?changedNames:deleted);
    for(let i=succeeded.length-1;i>=0;i--){
      const name=succeeded[i];if(!affected.has(name))continue;
      succeeded.splice(i,1);failed.push({name,stage:indexSaved?'order':'index',error:'索引/顺序写入失败；请刷新检查，批处理不是事务',audioDeleted:body.action==='delete',indexSaved,orderSaved});
    }
  }
  return jsonRes({ok:failed.length===0,action:body.action,succeeded,failed,count:succeeded.length,
    changed:body.action==='meta'?changedNames.filter(n=>succeeded.includes(n)).length:deleted.length,
    deletedAudio:deleted,atomic:false},failed.length?207:200);
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const bucket = env.MUSIC_BUCKET;

    try {
      for (const route of [routeApp,routeLyricsAppearance,routeManage]) { const response=await route(request,env,url); if(response) return response; }
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
        await bucket.delete('_lyrics/' + name + '.json');
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
