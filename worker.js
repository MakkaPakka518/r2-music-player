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

const VERSION = '1.0.0';

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
  let n = decodeURIComponent(name).replace(/[\\\/\0]/g, '').trim();
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

const HTML = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#08090d">
<title>R2 Music · 在线播放器</title>
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
}
html[data-theme="light"]{
  --bg:#f3f4f7; --panel:#ffffff; --panel2:#f4f5f8;
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
  min-height:100vh; padding-bottom:calc(var(--bar-h) + 76px);
}
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
.track .del{
  width:32px;height:32px;border-radius:9px;border:0;background:none;color:var(--dim);
  cursor:pointer;display:none;align-items:center;justify-content:center;flex-shrink:0
}
.track:hover .del{display:flex}
.track .del:hover{color:var(--err);background:rgba(251,113,133,.1)}
.track .del svg{width:16px;height:16px}
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
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      <div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
      <div><h1>R2 Music</h1><div class="ver">v${VERSION} · R2 播放器</div></div>
    </div>
    <button class="hbtn" id="btnAdmin" title="管理(上传/删除)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></button>
  </header>

  <div class="search">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
    <input id="q" placeholder="搜索歌曲…" autocomplete="off">
    <span class="clear" id="qClear">×</span>
  </div>

  <div class="upload-strip" id="upStrip">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>
    <div class="u-txt"><b>上传音乐</b> · mp3 / m4a / flac / ogg / wav,单文件 ≤ 50MB</div>
    <div class="u-progress"><i id="upBar"></i></div>
    <input type="file" id="upInput" accept=".mp3,.m4a,.flac,.ogg,.oga,.wav,.aac,.opus,.weba,audio/*" multiple hidden>
  </div>

  <div class="list" id="list"></div>
  <div class="empty" id="empty" style="display:none">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
    <div class="t1" id="emptyT1">还没有音乐</div>
    <div class="t2" id="emptyT2">点击右上角锁形按钮,登录后上传第一首</div>
  </div>
</div>

<div class="player">
  <div class="prog">
    <span class="time" id="curT">0:00</span>
    <div class="bar" id="pBar"><i id="pFill"></i></div>
    <span class="time" id="durT">-:--</span>
  </div>
  <div class="row">
    <div class="art"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
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

<div class="toast" id="toast"></div>

<script>
(function(){
  var list=[], playing=null, token=sessionStorage.getItem('r2m_token')||'';
  var audio=new Audio(); audio.preload='metadata';
  var qEl=document.getElementById('q'), listEl=document.getElementById('list'),
      emptyEl=document.getElementById('empty'), emptyT1=document.getElementById('emptyT1'),
      emptyT2=document.getElementById('emptyT2'),
      upStrip=document.getElementById('upStrip'), upInput=document.getElementById('upInput'),
      pName=document.getElementById('pName'), pSub=document.getElementById('pSub'),
      pBar=document.getElementById('pBar'), pFill=document.getElementById('pFill'),
      curT=document.getElementById('curT'), durT=document.getElementById('durT'),
      btnPlay=document.getElementById('btnPlay'), icPlay=document.getElementById('icPlay'), icPause=document.getElementById('icPause');

  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function fmtBytes(n){if(n==null)return'--';if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';return(n/1048576).toFixed(1)+' MB'}
  function fmtTime(s){if(!isFinite(s)||s<=0)return'-:--';s=Math.floor(s);var m=Math.floor(s/60),ss=s%60;return m+':'+(ss<10?'0':'')+ss}
  var lastPos={};
  function toast(msg,err){var t=document.getElementById('toast');t.textContent=msg;t.className='toast show'+(err?' err':'');clearTimeout(t._h);t._h=setTimeout(function(){t.className='toast'},2200)}

  // ---------- 加载列表 ----------
  function load(){
    fetch('/api/list').then(function(r){return r.json()}).then(function(d){
      list=(d.files||[]).sort(function(a,b){return a.name.localeCompare(b.name,'zh')});
      render();
    }).catch(function(e){toast('加载失败:'+e.message,1)});
  }
  function render(){
    var kw=qEl.value.trim().toLowerCase();
    var fl=list.filter(function(f){return !kw||f.name.toLowerCase().indexOf(kw)>=0});
    if(!fl.length){
      listEl.innerHTML='';emptyEl.style.display='block';
      emptyT1.textContent=list.length?'没有匹配的音乐':'还没有音乐';
      emptyT2.textContent=list.length?'换个关键词试试':'点击右上角锁形按钮,登录后上传第一首';
      return;
    }
    emptyEl.style.display='none';
    listEl.innerHTML=fl.map(function(f,i){
      var on=f.name===playing;
      return '<div class="track'+(on?' playing':'')+'" data-name="'+esc(f.name)+'">'
        +(on?'<span class="playing-bar"></span>':'')
        +'<span class="idx">'+String(i+1).padStart(2,'0')+'</span>'
        +'<span class="ic"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>'
        +'<span class="meta"><div class="name">'+esc(f.name)+'</div><div class="info">'+fmtBytes(f.size)+(f.dur?' · '+fmtTime(f.dur):'')+'</div></span>'
        +'<button class="del" data-del="1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>'
        +'</div>';
    }).join('');
  }
  // 列表事件委托(播放/删除),避免内联 onclick 转义问题
  listEl.addEventListener('click',function(e){
    var delBtn=e.target.closest('.del');
    var tr=e.target.closest('.track');
    if(!tr)return;
    var name=tr.getAttribute('data-name');
    if(delBtn){askDel(name)}else{play(name)}
  });
  qEl.addEventListener('input',render);
  document.getElementById('qClear').addEventListener('click',function(){qEl.value='';render()});

  // ---------- 播放 ----------
  function play(name){
    var f=list.filter(function(x){return x.name===name})[0];
    if(!f)return;
    playing=name;render();
    audio.src='/api/file/'+encodeURIComponent(name);
    audio.play().catch(function(){});
    pName.textContent=f.name;
    pSub.textContent='正在缓冲…';
    // 记忆播放进度
    var p=lastPos[name];if(p&&p>3&&p<f.dur-5){try{audio.currentTime=p}catch(e){}}
  }
  function toggle(){if(!playing&&list.length){play(list[0].name);return}if(audio.paused){audio.play().catch(function(){})}else{audio.pause()}}
  function step(dir){
    if(!list.length)return;
    var i=-1;list.forEach(function(f,k){if(f.name===playing)i=k});
    var n=(i<0?0:(i+dir+list.length)%list.length);
    play(list[n].name);
  }
  audio.addEventListener('loadedmetadata',function(){
    var f=list.filter(function(x){return x.name===playing})[0];
    if(f){f.dur=audio.duration;durT.textContent=fmtTime(audio.duration);render()}
    pSub.textContent=fmtTime(audio.duration);
  });
  audio.addEventListener('timeupdate',function(){
    pFill.style.width=(audio.duration?(audio.currentTime/audio.duration*100):0)+'%';
    curT.textContent=fmtTime(audio.currentTime);
  });
  audio.addEventListener('play',function(){icPlay.style.display='none';icPause.style.display='block';if(playing){pSub.textContent='播放中'}});
  audio.addEventListener('pause',function(){icPlay.style.display='block';icPause.style.display='none';if(playing)pSub.textContent='已暂停'});
  audio.addEventListener('ended',function(){if(playing)lastPos[playing]=0;step(1)});
  audio.addEventListener('waiting',function(){if(playing)pSub.textContent='缓冲中…'});
  // 播放进度记忆
  audio.addEventListener('pause',function(){if(playing&&audio.duration){lastPos[playing]=audio.currentTime}});
  pBar.addEventListener('click',function(e){
    var r=pBar.getBoundingClientRect(),x=(e.clientX-r.left)/r.width;
    if(audio.duration){audio.currentTime=x*audio.duration}
  });
  btnPlay.addEventListener('click',toggle);
  document.getElementById('btnPrev').addEventListener('click',function(){step(-1)});
  document.getElementById('btnNext').addEventListener('click',function(){step(1)});
  // 全局快捷键(桌面)
  document.addEventListener('keydown',function(e){
    if(e.code==='Space'&&e.target.tagName!=='INPUT'){e.preventDefault();toggle()}
    if(e.code==='ArrowRight')step(1);
    if(e.code==='ArrowLeft')step(-1);
  });

  // ---------- 管理(上传/删除) ----------
  var adminOn=!!token;
  function setAdmin(){
    if(adminOn){upStrip.classList.add('show')}
    else{upStrip.classList.remove('show')}
  }
  function askLogin(){var m=document.getElementById('loginModal');m.classList.add('show');setTimeout(function(){document.getElementById('tok').focus()},50)}
  function doLogin(){
    var v=document.getElementById('tok').value.trim();if(!v)return;
    // 用一次需要鉴权的请求验证令牌
    fetch('/api/verify',{method:'POST',headers:{'Authorization':'Bearer '+v}}).then(function(r){
      if(r.ok){token=v;adminOn=true;sessionStorage.setItem('r2m_token',token);setAdmin();toast('已登录,可以上传/删除');load();}
      else{toast('令牌不正确',1)}
      document.getElementById('loginModal').classList.remove('show');document.getElementById('tok').value='';
    }).catch(function(){toast('网络错误',1)});
  }
  document.getElementById('btnAdmin').addEventListener('click',function(){adminOn?setAdmin():askLogin()});
  document.getElementById('btnLoginOk').addEventListener('click',doLogin);
  document.getElementById('btnLoginNo').addEventListener('click',function(){document.getElementById('loginModal').classList.remove('show')});
  document.getElementById('tok').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin()});

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
  function askDel(name){delTarget=name;document.getElementById('delName').textContent=name;document.getElementById('delModal').classList.add('show')}
  document.getElementById('btnDelOk').addEventListener('click',function(){
    if(!delTarget)return;
    fetch('/api/file/'+encodeURIComponent(delTarget),{method:'DELETE',headers:{'Authorization':'Bearer '+token}}).then(function(r){
      document.getElementById('delModal').classList.remove('show');
      if(r.ok){if(playing===delTarget){audio.pause();playing=null}list=list.filter(function(f){return f.name!==delTarget});toast('已删除');render()}
      else{toast('删除失败',1)}
    });
  });
  document.getElementById('btnDelNo').addEventListener('click',function(){document.getElementById('delModal').classList.remove('show')});

  // 空态显示管理引导
  setAdmin();
  load();
  window.__r2m={play:play,askDel:askDel};
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
        return new Response(HTML, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }

      // 验证令牌(供前端登录确认)
      if (request.method === 'POST' && path === '/api/verify') {
        return new Response('{}', { status: authorized(request, env) ? 200 : 401, headers: { 'content-type': 'application/json' } });
      }

      // 文件列表
      if (request.method === 'GET' && path === '/api/list') {
        const listed = await bucket.list({ limit: 1000 });
        const files = listed.objects
          .filter((o) => isAudio(o.key))
          .map((o) => ({ name: o.key, size: o.size, uploaded: o.uploaded }))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        return new Response(JSON.stringify({ files, version: VERSION }), {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }

      // 上传(POST /api/upload?name=xxx)
      if (request.method === 'POST' && path === '/api/upload') {
        if (!authorized(request, env)) return new Response(JSON.stringify({ error: '需要管理令牌' }), { status: 401, headers: { 'content-type': 'application/json' } });
        const name = safeKey(url.searchParams.get('name') || '');
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
        if (!name) return new Response('Not Found', { status: 404 });
        const range = request.headers.get('Range');
        const object = await bucket.get(name, range ? { range } : undefined);
        if (!object) return new Response('Not Found', { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('accept-ranges', 'bytes');
        headers.set('cache-control', 'public, max-age=86400');
        if (range && object.range) {
          headers.set('content-range', 'bytes ' + object.range.offset + '-' + object.range.end + '/' + object.size);
          return new Response(object.body, { status: 206, headers });
        }
        return new Response(object.body, { status: 200, headers });
      }

      // 删除(DELETE /api/file/<name>)
      if (request.method === 'DELETE' && path.startsWith('/api/file/')) {
        if (!authorized(request, env)) return new Response(JSON.stringify({ error: '需要管理令牌' }), { status: 401, headers: { 'content-type': 'application/json' } });
        let raw = path.slice('/api/file/'.length);
        let name;
        try { name = safeKey(decodeURIComponent(raw)); } catch (e) { name = safeKey(raw); }
        if (!name) return new Response(JSON.stringify({ error: '文件名无效' }), { status: 400, headers: { 'content-type': 'application/json' } });
        await bucket.delete(name);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
  },
};
