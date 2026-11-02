// Runs inside the existing player closure, reusing its editor, auth and playlists.
export const TG_CLIENT_JS = String.raw`
  function tgHandlePrematureEnd(){
    var file=map[playing],expected=Number(file&&file.duration),position=audio.currentTime;
    if(!file||file.source!=='tgdrive'||!isFinite(expected)||expected<=0||position>=expected-Math.max(3,Math.min(10,expected*0.02)))return false;
    lastPos[playing]=Math.max(0,position||0);buffering=false;playFailed=true;
    pSub.textContent='音频连接提前结束，请点击歌曲继续';syncPlayback();
    toast('音频尚未播完，请点击当前歌曲重试',1);return true;
  }
  var tgPickerPage=1,tgPickerGeneration=0,tgPickerRows=[],tgPicked=new Map(),tgSearchTimer=null;
  var tgStyle=document.createElement('style');
  tgStyle.textContent='.tgdr-entry{display:none;margin:0 0 14px;width:100%}body.admin .tgdr-entry{display:block}.tgdr-modal{z-index:130}.tgdr-controls{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.tgdr-controls input{flex:1;min-width:150px}.tgdr-controls select{max-width:100%;width:100%;min-height:40px;border-radius:10px;background:var(--panel2);color:var(--txt);border:1px solid var(--hair2);padding:8px}.tgdr-results{max-height:42vh;overflow:auto}.tgdr-row{padding:10px 0;border-top:1px solid var(--hair);display:flex;align-items:center;gap:10px}.tgdr-row input[type=checkbox]{width:18px;height:18px;flex-shrink:0}.tgdr-copy{flex:1;min-width:0}.tgdr-copy input{width:100%;font-size:13px}.tgdr-copy small{display:block;font-size:11px;color:var(--dim);overflow-wrap:anywhere;margin-top:5px}.tgdr-pagination{display:flex;justify-content:center;align-items:center;gap:9px;margin:12px 0;font-size:12px}.tgdr-status{white-space:pre-wrap;overflow-wrap:anywhere}';
  document.head.appendChild(tgStyle);
  var tgEntry=document.createElement('button');tgEntry.id='tgdriveImport';tgEntry.className='tbtn tgdr-entry';tgEntry.textContent='从 TGDrive 添加歌曲 · 仅音频';upStrip.insertAdjacentElement('afterend',tgEntry);
  var tgModal=document.createElement('div');tgModal.id='tgdriveModal';tgModal.className='modal plus-modal tgdr-modal';tgModal.setAttribute('role','dialog');tgModal.setAttribute('aria-modal','true');tgModal.setAttribute('aria-label','从TGDrive添加歌曲');
  tgModal.innerHTML='<div class="sheet"><h3>从 TGDrive 添加歌曲</h3><p class="hint">复用已连接的TGDrive后端，仅显示音频。歌曲信息和海报保存到D1。</p><div class="tgdr-controls"><select id="tgSource" aria-label="选择TG音频来源"><option value="">全部音频来源</option></select><input id="tgSearch" placeholder="搜索歌名、文件名或消息" aria-label="搜索TG音频"><button class="tbtn" id="tgRefresh">搜索</button></div><p id="tgStatus" class="hint tgdr-status" role="status"></p><div id="tgResults" class="tgdr-results"></div><div class="tgdr-pagination"><button class="tbtn" id="tgPrevious">上一页</button><span id="tgPage"></span><button class="tbtn" id="tgNext">下一页</button><button class="tbtn" id="tgSelectPage">勾选本页</button></div><div class="lbl">新导入歌曲的专辑名（可留空）</div><input id="tgAlbum" maxlength="200" placeholder="导入后也可逐首编辑"><div class="lbl">统一海报HTTPS地址（可选）</div><input id="tgPoster" maxlength="2048" placeholder="也可导入后上传图片"><p id="tgSelected" class="hint"></p><div class="btns"><button class="btn-no" id="tgClose">关闭</button><button class="btn-ok" id="tgImport">导入所选歌曲</button></div></div>';
  document.body.appendChild(tgModal);
  var tgCoverWrap=document.createElement('div');tgCoverWrap.id='tgCoverUrlWrap';tgCoverWrap.hidden=true;
  tgCoverWrap.innerHTML='<div class="lbl">TG歌曲海报HTTPS地址（可选）</div><input id="tgCoverUrl" maxlength="2048" placeholder="填写链接，或用上方按钮上传海报"><p class="hint">歌名、专辑及海报存D1。上传图片会自动缩小，最大512KiB。</p>';
  $('eAlbum').insertAdjacentElement('afterend',tgCoverWrap);
  function tgEditSetup(file){
    var enabled=file.source==='tgdrive';tgCoverWrap.hidden=!enabled;$('tgCoverUrl').value=enabled?(file.posterUrl||''):'';
    if(enabled)$('editFile').textContent='TGDrive · '+(file.originalName||file.name);
  }
  function tgEditMetadata(name,value){if(map[name]&&map[name].source==='tgdrive')value.coverUrl=$('tgCoverUrl').value;return value}
  $('tgCoverUrl').oninput=function(){pendingCover=null;removeCover=false;var value=this.value.trim();showCover(/^https:\/\//i.test(value)?value:'')};
  $('cvClear').addEventListener('click',function(){$('tgCoverUrl').value=''});
  $('cvInput').addEventListener('change',function(){if(map[editTarget]&&map[editTarget].source==='tgdrive')$('tgCoverUrl').value=''});
  function tgUpdateSelection(){$('tgSelected').textContent='已勾选 '+tgPicked.size+' 首，可跨页选择';$('tgImport').disabled=!tgPicked.size}
  function tgRender(){
    $('tgResults').replaceChildren();
    tgPickerRows.forEach(function(item){
      var key=item.source_id+':'+item.id;if(item.imported)tgPicked.delete(key);
      var row=document.createElement('div');row.className='tgdr-row';
      var check=document.createElement('input');check.type='checkbox';check.checked=item.imported||tgPicked.has(key);check.disabled=!!item.imported;check.setAttribute('aria-label','选择 '+item.title);
      var copy=document.createElement('div');copy.className='tgdr-copy';
      var title=document.createElement('input');title.value=(tgPicked.get(key)||item).title||item.file_name;title.maxLength=200;title.disabled=!!item.imported;title.setAttribute('aria-label','自定义歌曲名');
      var hint=document.createElement('small');hint.textContent=[item.performer,item.source_title,item.file_name,item.imported?'已导入':''].filter(Boolean).join(' · ');
      title.oninput=function(){item.title=title.value;if(tgPicked.has(key))tgPicked.set(key,Object.assign({},item))};
      check.onchange=function(){if(check.checked)tgPicked.set(key,Object.assign({},item,{title:title.value}));else tgPicked.delete(key);tgUpdateSelection()};
      copy.append(title,hint);row.append(check,copy);$('tgResults').append(row);
    });tgUpdateSelection();
  }
  async function tgLoad(page){
    var generation=++tgPickerGeneration;$('tgStatus').textContent='正在读取音频…';
    try{
      var params=new URLSearchParams({page:String(page||1),source_id:$('tgSource').value,q:$('tgSearch').value.trim()});
      var result=await api('GET','/api/tgdrive/catalog?'+params);var data=await result.json();
      if(generation!==tgPickerGeneration)return;
      tgPickerRows=data.items.filter(function(item){return item.kind==='audio'&&String(item.mime).toLowerCase().indexOf('audio/')===0});
      tgPickerPage=data.page;tgRender();$('tgPage').textContent='第 '+data.page+' / '+data.pages+' 页';$('tgPrevious').disabled=data.page<=1;$('tgNext').disabled=!data.has_next;
      $('tgStatus').textContent='找到 '+data.total+' 个音频资源';
    }catch(error){if(generation===tgPickerGeneration)$('tgStatus').textContent=error.message}
  }
  tgEntry.onclick=async function(){
    if(!adminOn){askLogin();return}plusOpenDialog('tgdriveModal');$('tgStatus').textContent='连接TGDrive…';
    try{
      var response=await api('GET','/api/tgdrive/status');var state=await response.json();
      if(!state.enabled)throw new Error('请配置 MUSIC_DB、TGDRIVE_URL 和音频专用 TGDRIVE_TOKEN');
      response=await api('GET','/api/tgdrive/sources');var data=await response.json();
      var previous=$('tgSource').value;$('tgSource').replaceChildren(new Option('全部音频来源',''));
      data.sources.forEach(function(source){$('tgSource').append(new Option(source.title+' · '+source.audio_count+'首',source.id))});
      if(data.sources.some(function(source){return source.id===previous}))$('tgSource').value=previous;
      await tgLoad(1);
    }catch(error){$('tgStatus').textContent=error.message}
  };
  $('tgSearch').oninput=function(){clearTimeout(tgSearchTimer);tgPickerGeneration++;tgSearchTimer=setTimeout(function(){tgLoad(1)},350)};
  $('tgRefresh').onclick=function(){tgLoad(1)};$('tgSource').onchange=function(){tgLoad(1)};
  $('tgPrevious').onclick=function(){tgLoad(tgPickerPage-1)};$('tgNext').onclick=function(){tgLoad(tgPickerPage+1)};
  $('tgSelectPage').onclick=function(){tgPickerRows.forEach(function(item){if(!item.imported)tgPicked.set(item.source_id+':'+item.id,Object.assign({},item))});tgRender()};
  $('tgClose').onclick=function(){tgPickerGeneration++;plusCloseDialog('tgdriveModal')};
  tgModal.onclick=function(event){if(event.target===tgModal)$('tgClose').click()};
  document.addEventListener('keydown',function(event){if(event.key==='Escape'&&tgModal.classList.contains('show'))$('tgClose').click()});
  $('tgImport').onclick=async function(){
    if(!tgPicked.size)return;this.disabled=true;var added=0,failed=[];
    var entries=Array.from(tgPicked.values());
    try{
      for(var offset=0;offset<entries.length;offset+=10){
        $('tgStatus').textContent='正在导入 '+(offset+1)+'–'+Math.min(offset+10,entries.length)+' / '+entries.length+' 首…';
        var response=await api('POST','/api/tgdrive/import',JSON.stringify({album:$('tgAlbum').value,coverUrl:$('tgPoster').value,items:entries.slice(offset,offset+10).map(function(item){return {source_id:item.source_id,message_id:item.id,title:item.title}})}),'application/json');
        var data=await response.json();added+=data.added.length;failed=failed.concat(data.failed);
        data.added.forEach(function(song){var match=entries.find(function(item){return song.name.indexOf('tgdrive_'+item.source_id+'_'+item.id+'.')===0});if(match)tgPicked.delete(match.source_id+':'+match.id)});
      }
      load();await tgLoad(tgPickerPage);
      $('tgStatus').textContent='已导入 '+added+' 首'+(failed.length?'，'+failed.length+' 首失败：'+failed.map(function(item){return item.error}).join('；'):'。可在歌曲编辑中设置海报和专辑。');
      toast('TG歌曲导入 '+added+' 首',failed.length?1:0);
    }catch(error){$('tgStatus').textContent=error.message}
    finally{tgUpdateSelection()}
  };
`;
