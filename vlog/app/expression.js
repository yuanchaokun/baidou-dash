window.initExpressionCraft=function(core){
  const {S,Q,session,ui,detail}=core,$=(s,r=document)=>r.querySelector(s);
  const cn=()=>core.getLang()==='zh',t=(a,b)=>cn()?a:b;
  const view=$('#view-rec'),column=$('.camera-column');
  session.diary=false;view.classList.remove('diary-mode');
  const firstQuestions=[['今天有什么小事，让你现在还记得？','那一刻，你心里在想什么？','现在回看，你想对自己说什么？'],['What small moment from today stayed with you?','What was going through your mind then?','Looking back, what would you tell yourself?']];
  function ensureQuestions(){
    // Keep saved and preset questions. Only a genuinely empty list needs a default.
    const saved=S.questions[core.getLang()];
    if(!Array.isArray(saved)||!saved.some(q=>typeof q==='string'&&q.trim())){
      S.questions[core.getLang()]=firstQuestions[cn()?0:1].slice();
    }
  }
  ensureQuestions();
  const intro=document.createElement('div');intro.className='diary-intro';
  $('#recordModeLabel').before(intro);intro.append($('#recordModeLabel'));
  const guide=document.createElement('p');guide.id='diaryGuide';intro.append(guide);
  const steps=document.createElement('ol');steps.className='expression-steps';
  steps.innerHTML='<li><span>1</span><b id="guideStep1"></b></li><li><span>2</span><b id="guideStep2"></b></li><li><span>3</span><b id="guideStep3"></b></li>';intro.append(steps);
  const stage=document.createElement('div');stage.className='prompt-stage';
  stage.innerHTML='<div class="prompt-eyebrow"><span class="prompt-dot"></span><span id="promptEyebrow"></span><span id="promptCount"></span></div><h2 id="expressionPrompt" aria-live="polite"></h2><p id="promptSupport"></p><div class="prompt-actions"><button id="changeOpening" class="subtle-button" type="button"></button></div>';
  $('.frame').before(stage);
  const settings=document.createElement('details');settings.className='capture-settings';
  settings.innerHTML='<summary><span id="captureOptionsLabel"></span><span id="captureOptionsSummary"></span></summary><div class="capture-settings-body"><label class="format-picker"><span id="formatLabel"></span><select id="captureFormat" aria-label="录制比例"><option value="3:4">3:4 · 日志</option><option value="9:16">9:16 · 竖屏</option><option value="16:9">16:9 · 横屏</option><option value="1:1">1:1 · 方形</option></select></label><label class="trim-toggle"><input type="checkbox" id="trimSilence"><span class="switch-track"></span><span id="trimLabel"></span></label><button id="freeSpeak" class="subtle-button" type="button"></button></div>';
  $('.diary-heading').after(settings);
  const recFeedback=document.createElement('p');recFeedback.id='recordFeedback';$('.controls').after(recFeedback);
  const speakLabel=document.createElement('label');speakLabel.className='speak-toggle';speakLabel.innerHTML='<input type="checkbox" id="readQuestions"><span id="readQuestionsLabel"></span>';$('#cameraOptions').append(speakLabel);
  $('#trimSilence').checked=S.trimSilence!==false;
  $('#trimSilence').onchange=e=>{if(session.phase!=='idle')return;S.trimSilence=e.target.checked;core.saveSettings();sync();};
  $('#readQuestions').checked=S.speak;
  $('#readQuestions').onchange=e=>{S.speak=e.target.checked;core.saveSettings();};
  $('#captureFormat').value=core.getCaptureFormat().id;
  $('#captureFormat').onchange=e=>{if(!core.setCaptureFormat(e.target.value))e.target.value=core.getCaptureFormat().id;sync();};
  const openings=[['今天有什么小事，让你现在还记得？','最近做成了什么？再小也算。','今天有哪个瞬间，让你松了一口气？','有件什么事，你想慢慢说清楚？'],['What small moment from today stayed with you?','What did you get done recently, however small?','What moment helped you breathe a little easier today?','What is one thing you would like to talk through?']];
  let opening=0;
  $('#changeOpening').onclick=()=>{
    if(session.phase!=='idle')return;
    if(session.diary){session.diary=false;view.classList.remove('diary-mode');}
    else opening=(opening+1)%openings[0].length;
    const questions=Q().slice();questions[0]=openings[cn()?0:1][opening];S.questions[core.getLang()]=questions;
    S.coach.source='custom';core.saveSettings();sync();
  };
  $('#freeSpeak').onclick=()=>{
    if(session.phase!=='idle')return;
    session.diary=!session.diary;view.classList.toggle('diary-mode',session.diary);
    settings.open=false;
    sync();
  };
  function sync(){
    const busy=session.phase!=='idle',recording=session.phase==='recording';
    if(!busy)ensureQuestions();
    const rawStatus=core.assistant?.status;
    const assistant=typeof rawStatus==='string'?{state:rawStatus}:rawStatus||{};
    const state=assistant.state||assistant.status||'unavailable';
    const assistantReady=['ready','connected','enabled','followup','transcribing','thinking'].includes(state);
    const waiting=recording&&(session.thinking||session.waitingForAI||['transcribing','thinking'].includes(state));
    const captionsOn=assistantReady&&S.personalCaptions!==false;
    const followupOn=assistantReady&&S.personalFollowup!==false;
    const format=core.getCaptureFormat();column.dataset.format=format.id;
    column.dataset.assistant=state;
    $('#captureFormat').disabled=busy;$('#trimSilence').disabled=busy;$('#readQuestions').disabled=busy;
    $('#changeOpening').disabled=busy;$('#freeSpeak').disabled=busy;
    $('#promptEyebrow').textContent=session.diary?t('自由记录','Free recording'):waiting?t('正在接住你的话','Finding a follow-up'):recording&&state==='followup'?t('接着聊聊','A little further'):recording?t('正在聊的问题','Your question'):t('今天，从这里开始','Start here today');
    $('#promptCount').textContent=session.diary?'':recording?t('第 '+(session.qi+1)+' 问','Question '+(session.qi+1)):t('第 1 问','Question 1');
    const firstQuestion=Q().find(q=>typeof q==='string'&&q.trim())||firstQuestions[cn()?0:1][0];
    $('#expressionPrompt').textContent=session.diary?t('不用准备，随便说两句。','No script needed. Just start talking.'):recording?(session.q||assistant.question||firstQuestion):firstQuestion;
    $('#promptSupport').textContent=recording?(waiting?t('稍等一下，正在整理你刚才说的内容。','One moment while your answer is processed.'):t('可以停下来想。说完这一段，再点“这段说完了”。','Pauses are welcome. Tap “I’m done with this” when you finish.')):t('说一个具体的瞬间就好，不用组织得很完整。','Start with one moment. You don’t need to have it all worked out.');
    if(session.diary)$('#promptSupport').textContent=t('想到哪里说到哪里。想结束时，点“结束并回看”。','Follow your thoughts. Tap “Finish & watch” whenever you are ready.');
    $('#promptSupport').setAttribute('role',waiting?'status':'note');
    $('#changeOpening').textContent=session.diary?t('给我一个问题','Give me a question'):t('换个开头','Another opening');
    $('#freeSpeak').textContent=session.diary?t('跟着问题聊','Use guiding questions'):t('我想自由说','Just let me talk');
    $('#freeSpeak').hidden=false;
    $('#recordModeLabel').textContent=t('视频日志','Video diary');
    $('#diaryGuide').textContent=followupOn&&captionsOn?t('从下面的问题开始。说完一段，AI 接着问；录完自动生成字幕，可导出分享。','Start with the question below. AI can follow up, then create captions for an export you can share.'):followupOn?t('从下面的问题开始。说完一段，AI 会根据你的回答接着问。','Start with the question below. After your answer, AI can ask a follow-up.'):captionsOn?t('从下面的问题开始，说说今天。录完自动生成字幕，可导出分享。','Start with the question below. Captions are created after recording, ready for a shareable export.'):t('从下面的问题开始，说说今天。可以慢慢想，也可以换个问题。','Start with the question below. Take your time, or try another opening.');
    $('#guideStep1').textContent=t('看个问题','Pick a question');$('#guideStep2').textContent=t('慢慢说','Take your time');$('#guideStep3').textContent=t('回看分享','Watch & share');
    steps.setAttribute('aria-label',t('录制流程','Recording steps'));
    $('#customOpen').textContent=t('自定义话题','My own topic');
    $('#diaryMode').hidden=true;
    $('#captureOptionsLabel').textContent=t('录制选项','Recording options');
    $('#captureOptionsSummary').textContent=format.id+' · '+(S.trimSilence!==false?t('自动剪静默','Trim pauses'):t('保留停顿','Keep pauses'));
    $('#formatLabel').textContent=t('画幅','Format');
    $('#captureFormat').setAttribute('aria-label',t('录制比例','Recording aspect ratio'));
    const labels=cn()?['3:4 · 日志','9:16 · 竖屏','16:9 · 横屏','1:1 · 方形']:['3:4 · Diary','9:16 · Portrait','16:9 · Landscape','1:1 · Square'];
    Array.from($('#captureFormat').options).forEach((o,i)=>o.textContent=labels[i]);
    $('#trimLabel').textContent=t('自动剪静默','Trim pauses');
    $('#readQuestionsLabel').textContent=t('朗读问题','Read questions aloud');
    $('#btnNext').hidden=session.diary||!recording;$('#btnNext').textContent=waiting?t('正在处理…','Processing…'):t('这段说完了','I’m done with this');
    $('#btnNext').disabled=!recording||waiting;
    $('#shutterLabel').textContent=recording?t('结束并回看','Finish & watch'):session.phase==='countdown'?t('取消','Cancel'):session.phase==='finishing'?t('正在保存','Saving'):t('开始说','Start talking');
    $('#btnShutter').setAttribute('aria-label',$('#shutterLabel').textContent);
    $('#btnTheme').setAttribute('aria-label',t('切换明暗','Switch appearance'));$('#btnLang').setAttribute('aria-label',t('切换语言','Switch language'));
    $('#recordFeedback').textContent=recording?(S.trimSilence!==false?t('静默已剪去 ','Pauses trimmed: ')+Math.floor(session.cutMs/1000)+t(' 秒 · 原片完整保留','s · Original kept in full'):t('完整记录中 · 原片也会保留','Recording in full · Original kept')):t('视频保存在当前浏览器，重要记录记得下载。','Videos stay in this browser. Download the ones you want to keep.');
    const idleTitle=$('.idle-title');if(idleTitle)idleTitle.textContent=t('开始后开启镜头','Camera opens when you start');
    const note=$('.capture-note');if(note)note.hidden=true;
    $('#cameraOptions summary').textContent=t('画面与声音','Camera & sound');
  }
  ['recording','pill','idleMode'].forEach(name=>{const original=ui[name];ui[name]=function(...args){const r=original.apply(this,args);sync();return r;};});
  const ask=session.ask;session.ask=function(...args){const r=ask.apply(this,args);sync();return r;};
  const meters=ui.meters;let lastSecond=-1;ui.meters=function(...args){const r=meters.apply(this,args);const second=Math.floor(session.cutMs/1000);if(lastSecond!==second){lastSecond=second;sync();}return r;};
  $('#diaryMode').addEventListener('click',sync);
  $('#customDialog').addEventListener('close',sync);
  document.addEventListener('click',e=>{if(e.target.closest('#prepareGo'))sync();});
  document.addEventListener('cam:assistant-status',sync);
  window.addEventListener('cam:assistant-status',sync);
  core.syncExpression=sync;
  new MutationObserver(()=>queueMicrotask(sync)).observe(document.documentElement,{attributes:true,attributeFilter:['lang','data-theme']});
  const render=detail.render;detail.render=function(entry,...args){
    const result=render.call(this,entry,...args);if(!entry)return result;
    const selector=$('#vseg',this.el);if(selector){selector.classList.add('replay-switch');$('.player',this.el).before(selector);const buttons=selector.querySelectorAll('button');buttons[0].textContent=t('自动剪辑','Trimmed');buttons[1].textContent=t('原片','Original');}
    const info=document.createElement('p');info.className='clip-summary';info.textContent=entry.trimSilence===false?t('保留完整视频','Full recording kept'):t('已为你剪去 ','Trimmed ')+Math.round((entry.cutMs||0)/1000)+t(' 秒静默','s of pauses');
    $('.player',this.el).before(info);
    const download=$('.download-video',this.el);if(download){download.dataset.dl=entry.shareBlob?.size?'share':'orig';download.textContent=t('下载当前版本','Download this version');}
    if(selector)selector.addEventListener('click',e=>{const button=e.target.closest('button');if(!button)return;download.dataset.dl=button===selector.querySelector('button')?'share':'orig';});
    return result;
  };
  sync();
};
