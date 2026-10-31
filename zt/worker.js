/**
 * R2 Music Player — 配合 Cloudflare R2 的在线小型播放器
 * 单文件 Worker:粘贴到 Cloudflare Dashboard 即可部署
 *
 * 版本:2.1.0
 * 主题:拾链同款深绿青柠 / 音乐版首页；原八项功能与存储不变
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

const VERSION = '2.1.0';

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
const DEFAULT_NAME = '拾音';
const DEFAULT_SUB = 'R2 Music · 私人音乐收藏';
const NOTE_PATHS = '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>';
const DEFAULT_LOGO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + NOTE_PATHS + '</svg>';
const DEFAULT_FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#d1f879"/><stop offset="1" stop-color="#bce75c"/></linearGradient></defs>' +
  '<rect width="64" height="64" rx="16" fill="url(#g)"/>' +
  '<g transform="translate(16 16) scale(1.333)" fill="none" stroke="#193020" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + NOTE_PATHS + '</g></svg>';

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
<meta name="theme-color" content="#0b211e">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="color-scheme" content="dark light">
<title>%%TITLE%%</title>
%%ICONS%%
<script>
// 在渲染前就确定主题,避免浅色用户看到深色闪一下:有手动选择用手动选择,否则跟随系统
(function(){var t=null;try{t=localStorage.getItem('r2m_theme')}catch(e){}
if(t!=='light'&&t!=='dark'){t='dark'}
document.documentElement.setAttribute('data-theme',t);
var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',t==='light'?'#f2f5e9':'#0b211e')})();
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
<style id="sdThemeStyle">
/* ShareDrop 配色及排版，按音乐播放器适配；原项目同属用户。 */
:root,html[data-theme="dark"]{
 --bg:#0b211e;--panel:#142d28;--panel2:#0c211d;--elev:#1b3830;
 --hair:rgba(164,185,172,.13);--hair2:#2e4840;--txt:#eff5e7;--sub:#a4b9ac;--dim:#8fa699;
 --acc:#d1f879;--acc-deep:#bce75c;--acc-soft:rgba(209,248,121,.10);--ok:#d1f879;--err:#ffb1a3;--warn:#f1d28e;
 --sd-primary-ink:#193020;--sd-hero-copy:#bbccbf;--sd-card-border:rgba(72,99,71,.55);--sd-glow:#19433466;--sd-tint:#1b382e80;
 --sh:0 18px 60px #00000012;--r-lg:22px;--r:14px;--r-sm:10px;
 color-scheme:dark;
}
html[data-theme="light"]{
 --bg:#f2f5e9;--panel:#fbfcf5;--panel2:#e9efde;--elev:#fffef5;
 --hair:rgba(39,72,48,.12);--hair2:#ccd7be;--txt:#18382c;--sub:#536c59;--dim:#6c8069;
 --acc:#416723;--acc-deep:#35561c;--acc-soft:rgba(88,119,48,.10);--ok:#416723;--err:#af4039;--warn:#826220;
 --sd-primary-ink:#193020;--sd-hero-copy:#536c59;--sd-card-border:#c9d5b9;--sd-glow:#d8e5b566;--sd-tint:#e7edda80;
 --sh:0 18px 50px #28462f08;color-scheme:light;
}
html{background:var(--bg);scroll-padding-top:20px}
body{background-color:var(--bg);background-image:radial-gradient(ellipse at 4% 9%,var(--sd-glow),transparent 42%);line-height:1.65;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
body{--sd-primary-ink:#193020;--sd-hero-copy:#bbccbf;--sd-card-border:rgba(72,99,71,.55);--sd-glow:#19433466;--sd-tint:#1b382e80}
html[data-theme="light"] body{--sd-hero-copy:#536c59;--sd-card-border:#c9d5b9;--sd-glow:#d8e5b566;--sd-tint:#e7edda80}
body::before{display:none}
.wrap{width:min(1120px,calc(100% - 40px));max-width:1120px;margin-inline:auto;padding:0}
.wrap>header{padding-block:20px;margin:0;border-bottom:1px solid var(--hair);gap:9px}
.brand{gap:10px}.brand .logo{width:36px;height:36px;border-radius:11px;background:#d1f879;color:#193020;box-shadow:none}.brand .logo svg{width:25px;height:25px}
.brand h1{font-size:21px;font-weight:750;letter-spacing:.045em;line-height:1.25}.brand .ver{font-family:inherit;font-size:10px;letter-spacing:.06em;color:var(--sub);margin-top:4px}
.brand .logo.custom{background:none}.brand .logo.custom img{border-radius:11px}
.hbtn{width:35px;height:35px;background:transparent;border:1px solid var(--hair2);border-radius:50%;color:var(--sub)}
.sd-guide-link{border:0;background:none;color:var(--sub);font-size:11px;white-space:nowrap;min-height:40px;cursor:pointer;padding:0 3px}
.sd-guide-link:hover{color:var(--acc)}
.sd-workspace{padding-block:25px 26px;display:grid;gap:23px}
.sd-eyebrow{display:flex;align-items:center;gap:9px;font-size:11px;font-weight:650;letter-spacing:.1em;color:var(--sub)}.sd-spark{color:var(--acc);font-size:21px;line-height:1}
.sd-hero h2{font-size:clamp(37px,10vw,43px);line-height:1.23;font-weight:740;letter-spacing:-.055em;margin:13px 0 15px}.sd-hero h2 span{color:var(--acc)}
.sd-hero-copy{color:var(--sd-hero-copy);font-size:13px;line-height:1.8;max-width:39em}.sd-desktop-break{display:none}
.sd-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:17px}.sd-chips>span{display:flex;align-items:center;gap:6px;min-height:30px;border:1px solid var(--hair2);border-radius:8px;padding:4px 9px;background:var(--acc-soft);color:var(--sub);font-size:10px;white-space:nowrap}.sd-chips b{color:var(--acc);font-size:15px;line-height:1.1;font-weight:500}
.sd-hero-note{font-size:10px;color:var(--dim);letter-spacing:.03em;margin-top:10px}
.sd-listen-card{min-width:0;background:linear-gradient(125deg,var(--sd-tint),transparent 75%),var(--panel);border:1px solid var(--sd-card-border);border-radius:22px;padding:19px;box-shadow:var(--sh)}
.sd-section-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:15px}.sd-section-top h2{display:flex;gap:9px;align-items:center;font-size:16px;font-weight:600;letter-spacing:.02em}.sd-step{color:var(--acc);font-size:10px;letter-spacing:.05em;border:1px solid color-mix(in srgb,var(--acc) 30%,transparent);border-radius:50%;width:25px;height:25px;display:grid;place-items:center;flex-shrink:0}
.sd-mode-badge{font-size:10px;white-space:nowrap;border:1px solid color-mix(in srgb,var(--acc) 24%,transparent);padding:3px 7px;border-radius:20px;color:var(--acc)}
.sd-now-preview{display:flex;align-items:center;gap:12px;width:100%;text-align:left;min-width:0;border:1px solid var(--hair2);border-radius:13px;padding:14px 12px;background:var(--panel2);color:var(--txt);cursor:pointer}
.sd-now-preview:disabled{cursor:default;opacity:1}.sd-preview-art{display:flex;align-items:center;justify-content:center;width:62px;height:62px;flex-shrink:0;border-radius:50%;background:var(--acc-soft) center/cover no-repeat;color:var(--acc);border:5px solid #202924;box-shadow:0 0 0 1px #78817733}.sd-preview-art svg{width:30px;height:30px}.sd-preview-art.hascv svg{display:none}
.sd-preview-copy{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}.sd-preview-copy small{font-size:9px;color:var(--dim);letter-spacing:.06em}.sd-preview-copy strong{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sd-preview-copy>span{font-size:10px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sd-preview-arrow{color:var(--acc);font-size:21px;flex-shrink:0}
.sd-primary{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:47px;padding:11px 18px;border:0;border-radius:11px;background:#d1f879;color:#193020;font-family:inherit;font-size:14px;font-weight:650;line-height:1.4;margin-top:14px;cursor:pointer}.sd-primary>span:last-child{font-size:24px;font-weight:400;line-height:1}.sd-primary:hover{background:#dfff9b}.sd-primary:disabled{opacity:.46;cursor:not-allowed}
.sd-quick-actions{display:flex;justify-content:space-between;gap:10px;margin-top:5px}.sd-quick-actions button{border:0;background:none;color:var(--acc);font-size:10px;padding:6px 0;min-height:34px;cursor:pointer}.sd-quick-actions button>span{font-size:15px;margin-right:4px}.sd-quick-actions button:disabled{opacity:.4;cursor:default}
.sd-status{display:flex;gap:9px;align-items:flex-start;margin-top:9px}.sd-status i{width:7px;height:7px;border-radius:50%;background:var(--sub);margin:7px 2px 0;flex-shrink:0}.sd-status p{font-size:11px;font-weight:600}.sd-status p+p{font-size:10px;color:var(--sub);font-weight:400;margin-top:3px}.sd-service-line{font-size:9px;color:var(--dim);margin-top:18px}
.sd-library{min-width:0;border-top:1px solid var(--hair2);padding-top:23px}.sd-count{color:var(--dim);font-size:10px;white-space:nowrap}
.sd-library .search{background:var(--panel2);border-color:var(--hair2);height:45px;border-radius:12px;margin-bottom:11px}.search input{min-width:0;font-size:13px}.search:focus-within{border-color:var(--acc)}
.sd-tools{margin:11px 0 14px;border:1px solid var(--hair2);border-radius:13px;background:var(--panel)}.sd-tools>summary{cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;padding:10px 13px;list-style:none;font-size:11px;font-weight:600}.sd-tools>summary::-webkit-details-marker{display:none}.sd-tools>summary:after{content:'⌄';font-size:15px;color:var(--dim)}.sd-tools[open]>summary:after{content:'⌃'}.sd-tools>summary span{margin-left:auto;font-size:9px;font-weight:400;color:var(--dim)}
#plusToolbar{padding:0 12px 12px!important;margin:0!important;gap:7px!important}.sd-tools:not([open]) #plusToolbar{display:none!important}
#musicResumeSlot:empty{display:none}#musicResumeSlot .r2lib-resume{margin:0 0 22px;border:1px solid var(--hair2);background:var(--panel);padding:12px;font-size:12px}
/* 保留原控件与功能，只统一呈现 */
#musicLibrary .toolbar{gap:8px;margin-bottom:12px}#musicLibrary .seg{background:transparent;border-color:var(--hair2)}.seg button.on{background:var(--acc-soft);color:var(--acc)}
#musicLibrary .track{background:var(--panel);border:1px solid var(--hair2);border-radius:14px;box-shadow:none;padding:12px;gap:10px}#musicLibrary .track:hover{transform:none;border-color:var(--sub)}#musicLibrary .track.playing{border-color:color-mix(in srgb,var(--acc) 55%,transparent);background:linear-gradient(100deg,var(--acc-soft),transparent),var(--panel)}
#musicLibrary .track .name{font-size:13px;font-weight:600}#musicLibrary .track .info{font-family:inherit;color:var(--dim);font-size:10px;line-height:1.7}#musicLibrary .track .idx{background:var(--panel2);color:var(--dim);font-size:10px}#musicLibrary .track.playing .idx{color:var(--sd-primary-ink);background:var(--acc)}.track .playing-bar{background:var(--acc)}.track .ic svg{color:var(--acc)}
#musicLibrary .album{background:var(--panel);border:1px solid var(--hair2);box-shadow:none}#musicLibrary .album:hover{transform:none;border-color:var(--acc)}.albums{grid-template-columns:repeat(auto-fill,minmax(135px,1fr))}.album .an{font-size:13px}.album .as{font-size:10px}.ahead .an{font-size:20px}
.upload-strip{background:var(--panel2);border-color:var(--hair2);border-radius:13px}.upload-strip .u-txt{font-size:11px}.upload-strip .u-txt b{color:var(--acc)}
.player{background:color-mix(in srgb,var(--panel) 94%,transparent);border-color:var(--hair2);box-shadow:0 -10px 35px #0001}.player .row,.player .prog{max-width:920px;margin-inline:auto}.player .ctr .play,.player .ctr .play:hover{background:#d1f879;color:#193020;box-shadow:none}.player .art{border-color:var(--hair2);color:var(--acc);border-radius:50%}.player .bar i{background:var(--acc)}
.modal .sheet,.r2lib-panel,.la-dialog,.rm-dialog{background:var(--panel);color:var(--txt);border-color:var(--hair2);border-radius:20px;box-shadow:0 28px 90px #0004}
.modal .sheet{animation:none}.modal{background:#03100dc7}.modal .btn-ok,.la-button.la-primary{background:#d1f879;color:#193020;border-color:transparent}.modal .btn-no{background:var(--panel2);color:var(--sub)}.modal input,.la-field textarea,.la-field select{background:var(--panel2);border-color:var(--hair2);color:var(--txt)}
.la-field input[type=range]{accent-color:var(--acc)}.tbtn.pri,.tbtn.pri:hover{background:#d1f879;color:#193020;border-color:transparent}.la-button:focus-visible,.la-modal :focus-visible{outline-color:var(--acc)}.r2lib-liked,.rm-grip{color:var(--acc)}
button:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--acc);outline-offset:4px}
.now-player{background:radial-gradient(ellipse at 70% 20%,#244536,transparent 66%),#0b211e}.now-bg:not(.is-custom){opacity:.75}.now-btn{color:#eff5e7}.now-controls .now-play{color:#d1f879}.now-seek::-webkit-slider-runnable-track{background:linear-gradient(to right,#d1f879 var(--seek),rgba(239,245,231,.22) var(--seek))}.now-seek::-webkit-slider-thumb{background:#d1f879}.now-seek::-moz-range-progress,.now-seek::-moz-range-thumb{background:#d1f879}#nowExtras .r2lib-liked{color:#d1f879}.now-top .now-label b{letter-spacing:.08em;font-size:13px}.now-title{color:#eff5e7}.now-disc{border-color:rgba(209,248,121,.12)}
.sd-guide{border:1px solid var(--hair2);border-radius:15px;margin-top:24px;background:transparent;color:var(--txt)}.sd-guide>summary{list-style:none;cursor:pointer;padding:15px 18px;font-size:13px;font-weight:600}.sd-guide>summary::-webkit-details-marker{display:none}.sd-guide>summary span{float:right;color:var(--dim);font-size:10px;font-weight:400}.sd-guide-content{padding:0 18px 18px;display:grid;gap:16px}.sd-guide-content article{display:flex;gap:12px;align-items:flex-start}.sd-guide-content article>span{color:var(--acc);font-size:11px}.sd-guide h3{font-size:12px;margin-bottom:3px}.sd-guide p{font-size:11px;line-height:1.8;color:var(--sub)}
.sd-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:22px 0 12px;padding-top:16px;border-top:1px solid var(--hair);font-size:10px;color:var(--dim)}
@media(min-width:760px){.wrap>header{padding-block:25px}.brand h1{font-size:23px}.brand .logo{width:40px;height:40px}.sd-guide-link{font-size:12px;margin-right:9px}.hbtn{width:40px;height:40px}.sd-workspace{grid-template-columns:minmax(0,1fr) minmax(320px,.92fr);align-items:center;gap:50px;padding-block:48px 38px}.sd-hero h2{font-size:clamp(43px,5vw,62px);margin-block:18px 22px}.sd-eyebrow{font-size:12px}.sd-hero-copy{font-size:14px}.sd-desktop-break{display:block}.sd-chips{margin-top:23px}.sd-chips>span{font-size:11px}.sd-listen-card{padding:24px}.sd-section-top{margin-bottom:20px}.sd-status{margin-top:15px}.sd-listen-card .sd-service-line{margin-top:22px}.sd-guide-content{grid-template-columns:repeat(3,minmax(0,1fr))}.list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.albums{grid-template-columns:repeat(auto-fill,minmax(165px,1fr))}#musicLibrary .search{max-width:none}.sd-library{padding-top:28px}.sd-preview-copy strong{font-size:17px}}
@media(max-width:359px){.wrap{width:calc(100% - 28px)}.wrap>header{gap:6px}.brand h1{font-size:18px}.brand .logo{width:32px;height:32px}.brand{gap:7px}.brand .ver{font-size:9px}.hbtn{width:31px;height:31px}.hbtn svg{width:16px;height:16px}.sd-guide-link{font-size:10px;padding:0}.sd-guide-link .sd-guide-label{display:none}.sd-hero h2{font-size:36px}.sd-hero-copy{font-size:12px}.sd-listen-card{padding:16px}.sd-section-top h2{font-size:14px}.sd-chips{gap:5px}.sd-chips>span{font-size:9px;padding-inline:7px}.sd-preview-art{width:52px;height:52px}.sd-now-preview{gap:9px;padding:12px 10px}#musicLibrary .track{gap:6px;padding:10px 8px}.sd-footer{font-size:9px}}
@media(prefers-reduced-motion:reduce){.sd-now-preview,.sd-primary{transition:none}}

</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      %%LOGO%%
      <div class="bt"><h1 id="siteName">%%NAME%%</h1><div class="ver" id="siteSub">%%SUB%%</div></div>
    </div>
    <button class="sd-guide-link" type="button" id="musicGuideButton" aria-label="音乐播放器使用说明"><span class="sd-guide-label">使用说明 </span>↗</button>
    <button class="hbtn" id="btnTheme" title="切换主题"></button>
    <button class="hbtn adm" id="btnSite" title="站点设置(名称 / Logo / 播放背景)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    <button class="hbtn" id="btnAdmin" title="管理(上传/删除)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></button>
  </header>

<div class="sd-workspace">
  <section class="sd-hero" aria-labelledby="musicHeroTitle">
    <p class="sd-eyebrow"><span class="sd-spark" aria-hidden="true">✳︎</span> 少一点匆忙，多一点旋律</p>
    <h2 id="musicHeroTitle">好音乐，<br>慢慢<span>「听」见。</span></h2>
    <p class="sd-hero-copy">把喜欢的旋律，留在自己的音乐角落。<br class="sd-desktop-break">选一首，转动黑胶，让此刻有声。</p>
    <div class="sd-chips" aria-label="播放器特色"><span><b aria-hidden="true">♫</b> 私人曲库</span><span><b aria-hidden="true">◎</b> 黑胶唱片</span><span><b aria-hidden="true">≋</b> 滚动歌词</span><span><b aria-hidden="true">♡</b> 收藏歌单</span></div>
    <p class="sd-hero-note">音乐存在 R2 · 喜欢留在心里</p>
  </section>
  <section class="sd-listen-card" aria-labelledby="musicListenTitle">
    <div class="sd-section-top"><h2 id="musicListenTitle"><span class="sd-step">01</span> 给此刻，配一首</h2><span class="sd-mode-badge">R2 音乐库</span></div>
    <button class="sd-now-preview" id="musicPreview" type="button" aria-label="打开黑胶播放页" disabled><span class="sd-preview-art" id="musicPreviewArt" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M7 7a7 7 0 0 1 10 0M7 17a7 7 0 0 0 10 0"/></svg></span><span class="sd-preview-copy"><small id="musicPreviewLabel">准备好，让音乐响起</small><strong id="musicPreviewName">你的下一首喜欢</strong><span id="musicPreviewSub">从下面的曲库，挑一首开始</span></span><span class="sd-preview-arrow" aria-hidden="true">↗</span></button>
    <button class="sd-primary" type="button" id="musicStart" disabled><span id="musicStartLabel">正在读取曲库…</span><span aria-hidden="true">↗</span></button>
    <div class="sd-quick-actions"><button id="musicQuickLibrary" type="button"><span aria-hidden="true">♡</span> 我的收藏与歌单</button><button id="musicRandom" type="button" disabled><span aria-hidden="true">⤨</span> 随机听听</button></div>
    <div class="sd-status" aria-live="polite"><i id="musicStatusDot"></i><div><p id="musicStatusTitle">准备好，听见一份好心情</p><p id="musicStatusCopy">播放后点封面，进入你的黑胶时刻。</p></div></div>
    <p class="sd-service-line" id="musicServiceLine">曲库载入中 · 收藏与歌单只在本机</p>
  </section>
</div>
<div id="musicResumeSlot"></div>
<section class="sd-library" id="musicLibrary" aria-labelledby="musicLibraryTitle">
  <div class="sd-section-top"><h2 id="musicLibraryTitle"><span class="sd-step">02</span> 我的音乐库</h2><span id="musicCount" class="sd-count">等一首好音乐</span></div>

  <div class="search">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
    <input id="q" placeholder="搜索歌名、歌手或专辑…" autocomplete="off">
    <span class="clear" id="qClear">×</span>
  </div>

  <details class="sd-tools" id="musicTools"><summary>音乐工具<span>歌单 / 歌词 / 定时</span></summary><div id="plusToolbar" aria-label="音乐功能"></div></details>
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
</section>
<details class="sd-guide" id="musicGuide"><summary>给喜欢的音乐，一个角落。<span>使用说明 ⌄</span></summary><div class="sd-guide-content">
<article><span>01</span><div><h3>收进你的曲库</h3><p>点右上角锁形按钮进入管理，上传音乐。已有标签会自动补充歌名、歌手、专辑和封面。</p></div></article>
<article><span>02</span><div><h3>点一首，慢慢听</h3><p>播放后点封面进入黑胶页，再点唱片看歌词。歌词可由管理员上传，喜欢的歌可加入收藏或歌单。</p></div></article>
<article><span>03</span><div><h3>把喜欢留在身边</h3><p>音乐工具里可设置睡眠定时和添加到桌面。收藏、歌单和进度保存在本机，换设备前记得导出歌单。</p></div></article>
</div></details><footer class="sd-footer"><span>R2 Music · 让好音乐，好好留下。</span><span>v2.1.0</span></footer>
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
    updateBarHeight();plusEvent('playback');
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
    if(al){albumOpen=al.getAttribute('data-album');qEl.value='';render();$('musicLibrary').scrollIntoView({block:'start'});return}
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
    if(m)m.setAttribute('content',t==='light'?'#f2f5e9':'#0b211e');
    btnTheme.innerHTML=t==='light'?THEME_ICONS.dark:THEME_ICONS.light;
    btnTheme.title=t==='light'?'切换到深色主题':'切换到浅色主题';
    if(save)lsSet('r2m_theme',t);
  }
  btnTheme.addEventListener('click',function(){applyTheme(currentTheme()==='light'?'dark':'light',true)});
  applyTheme(currentTheme(),false);
  // 没手动选择过时,跟随系统主题变化
  try{
    var mq=window.matchMedia('(prefers-color-scheme: light)');
    var onMq=function(e){if(!lsGet('r2m_theme',''))applyTheme('dark',false)};
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


// 拾链主题的首页控制；复用原 Audio 与歌单/播放状态。
(function(){
  var loaded=false,previewName='',lastCover='';
  var start=$('musicStart'),startText=$('musicStartLabel'),preview=$('musicPreview'),previewArt=$('musicPreviewArt');
  // 保留首屏样式不移除，再追加覆盖层，避免部分 WebKit 重排继承变量时闪白。
  var override=document.createElement('style');override.id='sdThemeOverride';override.textContent=$('sdThemeStyle').textContent;document.head.appendChild(override);
  // 扩展会动态插入样式；同步刷新一次继承值，保留用户选择且不写入偏好。
  var initialTheme=currentTheme();document.documentElement.setAttribute('data-theme',initialTheme==='dark'?'light':'dark');void document.body.offsetHeight;applyTheme(initialTheme,false);
  var resume=document.querySelector('.r2lib-resume');if(resume)$('musicResumeSlot').appendChild(resume);
  function chosen(){return (playing&&map[playing])||sortFiles(list,sortMode,order)[0]||null}
  function update(){
    var f=chosen(),active=!!playing&&!audio.paused&&!audio.ended&&!audio.error&&!playFailed;
    previewName=f?f.name:'';
    $('musicCount').textContent=loaded?list.length+' 首歌曲':'等一首好音乐';
    var cover=f&&f.cover||'';
    if(cover!==lastCover){lastCover=cover;previewArt.style.backgroundImage=cover?'url('+JSON.stringify(cover)+')':'';previewArt.classList.toggle('hascv',!!cover)}
    $('musicPreviewName').textContent=f?(f.title||f.name):(loaded?'曲库还在等第一首':'你的下一首喜欢');
    $('musicPreviewSub').textContent=f?[f.artist||'未知歌手',f.album||'私人音乐收藏'].join(' · '):'从下面的曲库，挑一首开始';
    $('musicPreviewLabel').textContent=playing?(active?'正在播放 · 点封面进入黑胶页':'上次听到这里 · 点封面继续浏览'):'准备好，让音乐响起';
    preview.disabled=!f;start.disabled=!loaded||!list.length;$('musicRandom').disabled=!loaded||!list.length;
    startText.textContent=!loaded?'正在读取曲库…':!list.length?'等待第一首音乐':active?'暂停一下':playing?'继续播放':'开始播放';
    start.setAttribute('aria-label',startText.textContent);
    $('musicStatusTitle').textContent=active?'让旋律，接住此刻的心情':playing?'歇一会儿，好音乐还在这里':'准备好，听见一份好心情';
    $('musicStatusCopy').textContent=playing?(pStatus||'点击播放继续聆听'):'播放后点封面，进入你的黑胶时刻。';
    $('musicStatusDot').style.background=active?'var(--acc)':'var(--sub)';
    $('musicServiceLine').textContent=(loaded?list.length+' 首音乐已载入':'曲库载入中')+' · 收藏与歌单只在本机';
  }
  start.addEventListener('click',function(){
    if(!list.length)return;
    if(playing&&(audio.error||playFailed)){play(playing);return}
    if(playing){toggle();return}
    var names=visibleNames();if(!names.length)names=sortFiles(list,sortMode,order).map(function(f){return f.name});
    if(names.length)play(names[0],names);
  });
  preview.addEventListener('click',function(){
    if(!previewName)return;
    if(!playing)play(previewName,sortFiles(list,sortMode,order).map(function(f){return f.name}));
    openNow();
  });
  $('musicRandom').addEventListener('click',function(){
    if(!list.length)return;var names=visibleNames();if(!names.length)names=list.map(function(f){return f.name});
    setMode('shuffle',true);play(names[Math.floor(Math.random()*names.length)],names);
  });
  $('musicQuickLibrary').addEventListener('click',function(){var b=document.querySelector('#r2lib-tools>button');if(b)b.click()});
  $('musicGuideButton').addEventListener('click',function(){var g=$('musicGuide');g.open=true;g.scrollIntoView({block:'start',behavior:'auto'});g.querySelector('summary').focus({preventScroll:true})});
  document.addEventListener('r2:loaded',function(){loaded=true;update()});
  document.addEventListener('r2:track',update);document.addEventListener('r2:playback',update);
  ['playing','play','pause','ended','waiting','error','canplay','emptied'].forEach(function(e){audio.addEventListener(e,update)});
  // 上传/批处理时展开工具区，让失败和成功摘要可见。
  var tools=$('musicTools'),status=document.querySelector('.rm-status[role="status"]');
  if(status)new MutationObserver(function(){if(status.textContent.trim())tools.open=true}).observe(status,{childList:true,characterData:true,subtree:true});
  document.querySelectorAll('#nowExtras .rm-now').forEach(function(b){b.addEventListener('click',function(){tools.open=true;tools.scrollIntoView({block:'center'})})});
  update();
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
const APP_SW="const CACHE='r2music-static-v2.1.0';\nconst STATIC=['/app-icon-192.png','/app-icon-512.png','/offline'];\nself.addEventListener('install',event=>{\n  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(STATIC)));\n});\nself.addEventListener('activate',event=>{\n  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('r2music-static-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));\n});\nself.addEventListener('message',event=>{\n  if(event.data&&event.data.type==='SKIP_WAITING')self.skipWaiting();\n});\nself.addEventListener('fetch',event=>{\n  const request=event.request,url=new URL(request.url);\n  if(request.method!=='GET'||url.origin!==self.location.origin)return;\n  // 不缓存歌曲、带令牌请求、管理接口、歌词或用户页面。\n  if(url.pathname.startsWith('/api/')||request.headers.has('authorization'))return;\n  if(request.mode==='navigate'){\n    event.respondWith(fetch(request).catch(()=>caches.match('/offline').then(cached=>cached||new Response('当前离线，请联网后重试',{headers:{'content-type':'text/plain;charset=utf-8'}}))));return;\n  }\n  if(STATIC.includes(url.pathname))event.respondWith(caches.match(url.pathname).then(cached=>cached||fetch(request)));\n});\n";
const APP_OFFLINE="<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\"><meta name=\"theme-color\" content=\"#0b211e\"><title>暂时离线</title><style>body{margin:0;min-height:100vh;display:grid;place-content:center;text-align:center;background:#0b211e;color:#eff5e7;font:16px/1.8 system-ui;padding:24px;box-sizing:border-box}img{width:90px;border-radius:22px;margin:auto}p{color:#a4b9ac;font-size:14px}a{color:#d1f879}</style><img src=\"/app-icon-192.png\" alt=\"音乐\"><h2>暂时没有网络</h2><p>歌曲需要联网播放。<br>你的本机歌单和收藏仍保留。</p><a href=\"/\">联网后重新打开</a></html>";
async function routeApp(request,env,url){
 if(request.method!=='GET')return null;
 if(url.pathname==='/manifest.webmanifest'){
  const site=await readSite(env.MUSIC_BUCKET),name=String(site.name||DEFAULT_NAME).slice(0,30);
  return new Response(JSON.stringify({id:'/',name,short_name:name.slice(0,12),description:'私人音乐与黑胶播放器',lang:'zh-CN',start_url:'/?app=1',scope:'/',display:'standalone',background_color:'#0b211e',theme_color:'#0b211e',icons:[{src:'/app-icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},{src:'/app-icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]}),{headers:{'content-type':'application/manifest+json;charset=utf-8','cache-control':'no-cache'}});
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
