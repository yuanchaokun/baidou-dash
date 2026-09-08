/* Guided video journaling. No provider key is stored or sent by this module. */
window.initJournalCoach = function (core) {
  'use strict';
  const {S, Q, saveSettings, session, DB, detail, ui, cam, audio} = core;
  const $ = (s, root = document) => root.querySelector(s);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
  const zh = () => core.getLang() === 'zh';
  const txt = (cn, en) => zh() ? cn : en;
  const topics = {
    daily: {label:['日常','Everyday'], questions:[['今天有什么小事，你想留给以后的自己？','回看今天，你什么时候最像自己？','现在的你想对镜头说一句什么话？'],['What small moment do you want to remember from today?','When did you feel most like yourself today?','What would you like to say to the camera right now?']]},
    work: {label:['工作','Work'],questions:[['今天推进了什么？说说一个具体的结果。','哪里卡住了，你试过什么办法？','明天最值得先做的一小步是什么？'],['What did you move forward today? Describe one concrete result.','Where did you get stuck, and what did you try?','What is the first small step worth taking tomorrow?']]},
    investing: {label:['投资复盘','Investing'],questions:[['这次判断基于哪些事实，哪些是你的假设？','如果判断错了，你能承受的损失和退出条件是什么？','你准备记录什么证据，之后检验这次判断？'],['Which parts of your decision are facts, and which are assumptions?','If you are wrong, what loss can you accept and when would you exit?','What evidence will you record to review your judgment later?']]},
    relationships: {label:['关系','Relationships'],questions:[['最近哪次相处让你印象深刻？发生了什么？','你当时想表达什么，对方实际听到的可能是什么？','下一次见面，你想试着多说或多听什么？'],['Which recent interaction stayed with you? What happened?','What did you mean to express, and what might they have heard?','What would you like to say or listen for next time?']]},
    reading: {label:['阅读','Reading'],questions:[['最近读到哪个想法，让你想停下来多想一会儿？','不用原文，你会怎样把它讲给朋友听？','它和你的经历有什么联系，或者哪里还说不通？'],['Which idea from your reading made you pause?','How would you explain it to a friend in your own words?','How does it connect with your experience, or what is still unclear?']]},
    practice: {label:['表达练习','Speaking'],questions:[['用一分钟介绍一个你在意的事，让第一次听的人也能懂。','换一个具体的例子，再讲一次。','等下回看时，你最想留意自己的语速、停顿还是姿态？'],['Explain something you care about to someone new to it.','Explain it again using one concrete example.','When you watch this back, will you notice your pace, pauses or posture?']]}
  };
  const styles = {gentle:['温和陪伴','Gentle'],direct:['直接提问','Direct'],reflective:['深入反思','Reflective']};
  const hadSettings = !!localStorage.getItem('vlog.settings');
  S.coach = Object.assign({topic:'daily',style:'gentle',goal:'',source: hadSettings ? 'saved' : 'builtin'}, S.coach || {});
  if (!topics[S.coach.topic]) S.coach.topic = 'daily';
  if (!styles[S.coach.style]) S.coach.style = 'gentle';
  S.coach.goal = String(S.coach.goal || '').slice(0, 600);
  let revision = 0, generating = false, accessCode = '', api = {available:false,requiresAccessCode:false}, statusKnown = false;
  let notice = '', captureStep = false;
  const prep = $('#coachPrep'), view = $('#view-rec');
  session.diary = true;
  view.classList.add('diary-mode','capture-step');
  const modal=document.createElement('dialog');
  modal.id='customDialog';
  modal.innerHTML='<div class="custom-head"><h2>'+txt('自定义问题','Your questions')+'</h2><button class="text-link" id="closeCustom" aria-label="'+txt('关闭','Close')+'">✕</button></div>';
  modal.append(prep);document.body.append(modal);
  const modebar=document.createElement('div');modebar.className='diary-heading';
  modebar.innerHTML='<h1 id="recordModeLabel">'+txt('视频日志','Video diary')+'</h1><button class="text-link" id="customOpen">'+txt('自定义','Customize')+'</button><button class="text-link" id="diaryMode" hidden>'+txt('恢复日志','Back to diary')+'</button>';
  $('.camera-column').prepend(modebar);
  $('#customOpen').onclick=()=>{if(!idle())return;modal.showModal();prep.querySelectorAll('[data-question]').forEach(autoHeight);};
  $('#closeCustom').onclick=()=>modal.close();
  $('#diaryMode').onclick=()=>{if(!idle())return;session.diary=true;view.classList.add('diary-mode');sync();};
  modal.addEventListener('close',()=>$('#customOpen').focus());
  const options=document.createElement('details');options.id='cameraOptions';options.innerHTML='<summary>'+txt('画面','Camera options')+'</summary>';options.append($('#btnMirror'),$('#filters'));$('.capture-dock').append(options);
  const note=document.createElement('p');note.className='capture-note';note.textContent=txt('视频仅存本机，记得下载。','Saved in this browser. Download to keep.');$('.capture-dock').append(note);


  const getBuiltins = () => topics[S.coach.topic].questions[zh() ? 0 : 1].slice();
  const idle = () => session.phase === 'idle';
  function persist() { try {saveSettings();} catch (_) { notice = txt('设置暂时无法保存；仍可继续录制。','Settings could not be saved; you can still record.'); } }
  function builtin() { S.questions[core.getLang()] = getBuiltins(); S.coach.source = 'builtin'; persist(); }
  const urlTopic = new URLSearchParams(location.search).get('topic');
  if (Object.hasOwn(topics, urlTopic || '')) { S.coach.topic = urlTopic; builtin(); }
  else if (!hadSettings) builtin();
  const sourceText = () => ({builtin:txt('内置问题 · 可直接修改','Built-in questions · editable'),deepseek:txt('DeepSeek 生成 · 可直接修改','Generated by DeepSeek · editable'),custom:txt('已编辑的问题','Edited questions'),saved:txt('上次保存的问题 · 可直接修改','Saved questions · editable')}[S.coach.source] || txt('已保存的问题','Saved questions'));
  const statusText = () => !statusKnown ? txt('正在检查 AI 服务…','Checking AI service…') : api.available ? txt('主题、提问风格和目标会发送给 DeepSeek。视频不会发送。','Topic, style and goal go to DeepSeek. Video is not sent.') : txt('AI 暂不可用。内置问题照常使用，也可以自己修改。','AI is unavailable. Use or edit the built-in questions.');
  function render() {
    const aiWasOpen=!!$('.ai-compose[open]',prep);
    prep.innerHTML = `<div class="prep-intro"><h2>${txt('这次想聊什么？','What would you like to talk about?')}</h2><p>${txt('1. 选题　→　2. 录下来　→　3. 回头看看','1. Choose a topic → 2. Record → 3. Look back')}</p></div>
      <fieldset class="coach-fields"><legend>${txt('主题','Topic')}</legend><div class="topic-options">${Object.entries(topics).map(([k,v]) => `<button type="button" data-topic="${k}" aria-pressed="${S.coach.topic===k}" class="topic-btn">${esc(v.label[zh()?0:1])}</button>`).join('')}</div></fieldset>
      <div class="coach-options"><label for="coachStyle">${txt('提问风格','Question style')}</label><select id="coachStyle">${Object.entries(styles).map(([k,v])=>`<option value="${k}" ${k===S.coach.style?'selected':''}>${esc(v[zh()?0:1])}</option>`).join('')}</select></div>
      <label class="goal-label" for="coachGoal">${txt('想达成什么？','What is your goal?')} <span>${txt('选填，一句话就好','Optional, a sentence is enough')}</span></label>
      <textarea id="coachGoal" maxlength="600" rows="2" placeholder="${txt('比如：把今天的工作讲清楚；复盘一次投资判断；练习更自然地表达。','For example: explain my work clearly, review a decision, or speak more naturally.')}">${esc(S.coach.goal)}</textarea>
      <p class="topic-note" ${S.coach.topic==='investing'?'':'hidden'}>${txt('复盘自己的判断、证据和风险，不提供荐股或买卖指令。','Review your reasoning, evidence and risk; no stock picks or trading instructions.')}</p>
      <div class="question-heading"><h3>${txt('这次的问题','Your questions')}</h3><span id="questionSource">${sourceText()}</span></div>
      <ol class="editable-questions" id="questionPreview">${Q().map((q,i)=>`<li><span>${i+1}</span><textarea rows="1" maxlength="300" data-question="${i}" aria-label="${txt('问题','Question')} ${i+1}">${esc(q)}</textarea></li>`).join('')}</ol>
      <div class="ai-actions"><button class="btn" id="generateQuestions" type="button">${txt('帮我生成问题','Generate questions')}</button><button class="text-link" id="builtinQuestions" type="button">${txt('用内置问题','Use built-in questions')}</button></div>
      <div class="access-wrap" ${api.requiresAccessCode?'':'hidden'}><label for="coachAccess">${txt('AI 访问码','AI access code')}</label><div class="access-input"><input id="coachAccess" type="password" autocomplete="off" placeholder="${txt('由站点维护者提供','Provided by the site owner')}" value="${esc(accessCode)}"><button type="button" class="text-link" data-show-access="coachAccess">${txt('显示','Show')}</button></div></div>
      <p id="coachService" class="coach-note">${statusText()}</p><p id="coachNotice" class="coach-notice" role="status" aria-live="polite">${esc(notice)}</p>
      <button class="btn solid prepare-go" id="prepareGo">${txt('去录制 →','Go to recording →')}</button><p class="local-note">${txt('视频保存在当前浏览器。重要记录请下载备份。','Videos stay in this browser. Download important recordings.')}</p>`;
    $('.prep-intro',prep).remove();
    const advanced=document.createElement('details');advanced.className='ai-compose';
    advanced.innerHTML='<summary>'+txt('让 AI 帮我出题','Ask AI for questions')+'</summary>';
    Array.from(prep.children).filter(n=>!n.matches('.question-heading,#questionPreview,#coachNotice,#prepareGo,.local-note')).forEach(n=>advanced.append(n));
    $('#questionPreview').after(advanced);
    advanced.open=aiWasOpen;
    $('.local-note',prep).hidden=true;
    $('#prepareGo').textContent=txt('用这些问题','Use these questions');
    const add=document.createElement('button');add.className='text-link';add.id='addQuestion';add.textContent=txt('加一个问题','Add a question');
    $('#questionPreview').after(add);
    prep.querySelectorAll('[data-question]').forEach((field,i)=>{const remove=document.createElement('button');remove.className='remove-question';remove.type='button';remove.textContent='×';remove.setAttribute('aria-label',txt('删除问题','Remove question')+' '+(i+1));remove.disabled=Q().length<2;remove.onclick=()=>{if(Q().length<2)return;S.questions[core.getLang()]=Q().filter((_,n)=>n!==i);S.coach.source='custom';persist();render();};field.parentElement.append(remove);});
    add.onclick=()=>{if(Q().length>=10)return;S.questions[core.getLang()]=[...Q(),''];S.coach.source='custom';persist();render();$('#questionPreview li:last-child textarea').focus();};
    $('#backPrepare').textContent = txt('← 返回选题','← Back to questions');
    $('#btnNext').textContent = txt('下一题','Next question');
    $('#generateQuestions').onclick = generateQuestions;
    $('#builtinQuestions').onclick = () => { if (!idle()) return; revision++; notice=''; builtin(); render(); };
    $('#prepareGo').onclick = () => {
      if (!validQuestions()) return;
      session.diary=false;view.classList.remove('diary-mode');modal.close();sync();
      captureStep = true; view.classList.add('capture-step');
      $('.camera-column').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
      $('#btnCam').focus({preventScroll:true});
    };
    $('#coachStyle').onchange = e => { if (!idle()) return; S.coach.style = e.target.value; revision++; persist(); };
    $('#coachGoal').oninput = e => { if (!idle()) return; S.coach.goal = e.target.value; revision++; persist(); };
    $('#coachAccess').oninput = e => {accessCode=e.target.value;};
    prep.querySelectorAll('[data-question]').forEach(autoHeight);
    sync();
  }
  function autoHeight(node) { if (!node.getClientRects().length) return; node.style.height = 'auto'; node.style.height = (node.scrollHeight + 2) + 'px'; }
  function validQuestions() {
    if (Q().every(q => q.trim())) return true;
    notice = txt('请先填写空着的问题，或选择“用内置问题”。','Fill in the blank questions, or use built-in questions.');
    $('#coachNotice').textContent = notice;
    $('#questionPreview textarea').focus();
    return false;
  }
  prep.addEventListener('click', e => {
    const b=e.target.closest('[data-topic]');
    if (b && idle()) { S.coach.topic=b.dataset.topic; revision++; notice=''; builtin(); render(); }
    const show=e.target.closest('[data-show-access]');
    if(show){const input=$('#'+show.dataset.showAccess); input.type=input.type==='password'?'text':'password';show.textContent=input.type==='password'?txt('显示','Show'):txt('隐藏','Hide');}
  });
  prep.addEventListener('input', e => {
    if (!e.target.matches('[data-question]') || !idle()) return;
    autoHeight(e.target);
    const qs=Q().slice(); qs[Number(e.target.dataset.question)]=e.target.value.slice(0,300);
    S.questions[core.getLang()]=qs; S.coach.source='custom'; revision++;persist();$('#questionSource').textContent=sourceText();
  });
  $('#backPrepare').onclick=()=>{if(!idle())return;captureStep=false;view.classList.remove('capture-step');prep.querySelectorAll('[data-question]').forEach(autoHeight);prep.scrollIntoView({behavior:'smooth',block:'start'});$('#coachGoal').focus({preventScroll:true});};
  async function request(body) {
    const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),45000);
    try {
      const response=await fetch('/api/coach',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,...(api.requiresAccessCode?{accessCode}: {})}),signal:controller.signal});
      let data={}; try{data=await response.json();}catch(_){}
      if(!response.ok){
        const messages={401:txt('访问码不正确，请重新输入。','The access code is incorrect.'),403:txt('这个请求暂时无法使用 AI 服务。','AI is not available for this request.'),429:txt('请求有点多，请稍后再试。','Too many requests. Please try later.'),503:txt('AI 服务暂未就绪，请稍后再试。','AI service is not ready. Please try later.')};
        throw new Error((typeof data.error?.message==='string' && data.error.message.slice(0,240))||messages[response.status]||txt('AI 服务暂时没有回应，请稍后再试。','AI service did not respond. Please try again later.'));
      }
      return data;
    }catch(e){if(e.name==='AbortError')throw new Error(txt('AI 等待超时，请稍后再试。','The AI request timed out. Please try later.'));if(e instanceof TypeError)throw new Error(txt('网络连接失败，请稍后再试。','Network connection failed. Please try later.'));throw e;}finally{clearTimeout(timer);}
  }
  async function generateQuestions() {
    if(!idle()||generating)return;
    if(statusKnown && !api.available){notice=txt('AI 暂不可用，当前问题仍可编辑、直接开录。','AI is unavailable. You can edit these questions and record.');$('#coachNotice').textContent=notice;return;}
    if(api.requiresAccessCode && !accessCode.trim()){notice=txt('请填写 AI 访问码，或直接用内置问题录制。','Enter the AI access code, or record using built-in questions.');$('#coachNotice').textContent=notice;$('#coachAccess').focus();return;}
    const ticket=++revision, lang=core.getLang(); generating=true; notice=txt('正在根据你的选择生成问题…','Generating questions from your choices…');sync();$('#coachNotice').textContent=notice;
    try{
      const result=await request({action:'questions',topic:S.coach.topic,style:S.coach.style,goal:S.coach.goal,count:3,lang});
      if(ticket!==revision || !idle() || lang!==core.getLang()) {notice=txt('你的选择已变化，本次生成结果未应用。','Your choices changed; the generated questions were not applied.');return;}
      if(result.source!=='deepseek'||!Array.isArray(result.questions)||result.questions.length!==3||result.questions.some(q=>typeof q!=='string'||!q.trim()||q.length>300))throw new Error(txt('返回的问题格式不完整，请重试。','The question response was incomplete. Please try again.'));
      S.questions[lang]=result.questions.map(q=>q.trim());S.coach.source='deepseek';persist();notice=txt('问题准备好了。可以再改一改，然后去录制。','Questions are ready. Edit anything you like, then record.');
    }catch(e){notice=e.message+' '+txt('当前问题已保留。','Your current questions are unchanged.');}
    finally{generating=false;render();}
  }
  function sync() {
    const busy=!idle();
    $('#customOpen').disabled=busy;$('#diaryMode').disabled=busy;
    $('#diaryMode').hidden=session.diary;
    $('#recordModeLabel').textContent=session.diary?txt('视频日志','Video diary'):txt('自定义录制','Custom recording');
    $('#btnNext').hidden=session.diary;

    if (!busy) prep.querySelectorAll('[data-question]').forEach(autoHeight);
    prep.querySelectorAll('button,textarea,select,input').forEach(n=>{n.disabled=busy;});
    prep.querySelectorAll('.remove-question').forEach(n=>{n.disabled=busy||Q().length<2;});
    $('#addQuestion').disabled=busy||Q().length>=10;
    $('#generateQuestions').disabled=busy||generating;
    $('#generateQuestions').textContent=generating?txt('正在生成…','Generating…'):txt('帮我生成问题','Generate questions');
    $('#backPrepare').disabled=busy;
    $('#shutterLabel').textContent=session.phase==='recording'?txt('结束录制','Stop recording'):session.phase==='countdown'?txt('取消倒计时','Cancel'):session.phase==='finishing'?txt('正在保存…','Saving…'):txt('开始录制','Record');
    $('#btnShutter').setAttribute('aria-label',$('#shutterLabel').textContent);
    $('#btnShutter').disabled=session.phase==='finishing';
    if(busy){captureStep=true;view.classList.add('capture-step');}
    $('.nav [data-view="cal"]').disabled=busy;
    $('#btnLang').disabled=busy;
    $('#settingsModal [data-k="questions"]').disabled=busy;
  }
  ['recording','pill','idleMode'].forEach(name=>{const original=ui[name];ui[name]=function(...args){const result=original.apply(this,args);sync();return result;};});
  const originalBegin=session.begin;
  session.begin=async function(...args){if(!session.diary&&!validQuestions())return;revision++;if(audio.ctx?.state==='suspended')audio.ctx.resume().catch(()=>{});const promise=originalBegin.apply(this,args);sync();try{return await promise;}finally{sync();}};
  const originalReset=session.reset;
  session.reset=function(...args){const result=originalReset.apply(this,args);sync();return result;};
  $('#btnCam').addEventListener('click',()=>{captureStep=true;view.classList.add('capture-step');});
  $('#settingsModal').addEventListener('input',e=>{if(e.target.matches('[data-k="questions"]')&&idle()){S.coach.source='custom';revision++;persist();render();}});
  new MutationObserver(()=>{revision++;notice='';if(S.coach.source==='builtin')builtin();else{S.coach.source='saved';persist();}render();}).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});

  /* Feedback is opt-in: the exact text is shown before an explicit send. */
  function feedbackHTML(feedback){
    if(!feedback)return '';
    return `<div class="feedback-result"><h4>${txt('文字反馈','Text feedback')}</h4><p>${esc(feedback.summary)}</p><ul>${(feedback.observations||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul><h4>${txt('下一小步','One next step')}</h4><p>${esc(feedback.nextStep)}</p></div>`;
  }
  const originalDetail=detail.render;
  detail.render=function(entry,siblings){
    originalDetail.call(this,entry,siblings);if(!entry)return;
    const exports=document.createElement('details');exports.className='export-details';
    exports.innerHTML='<summary>'+txt('更多选项','More options')+'</summary>';
    const aside=$('.player .aside',this.el),saved=$('.saved',this.el),qa=$('.qa',this.el),actions=$('.actions',this.el);
    $('.player',this.el).after(exports);
    if(aside)exports.append(aside);if(saved)exports.append(saved);if(qa)exports.append(qa);if(actions)exports.append(actions);
    const dl=document.createElement('button');dl.className='btn download-video';dl.dataset.dl='orig';dl.textContent=txt('下载视频','Download video');$('.player',this.el).after(dl);

    const section=document.createElement('details');section.className='feedback-section';
    const qaText=(entry.qa||[]).filter(x=>typeof x.a==='string'&&x.a.trim()).map(x=>x.q+'\n'+x.a).join('\n\n');
    const draft=typeof entry.feedbackDraft==='string'?entry.feedbackDraft:qaText;
    section.innerHTML=`<summary>${txt('写几句','Add a note')}</summary><div class="feedback-body"><p>${txt('文字保存在本机。需要时，再让 AI 给些反馈。','Notes stay here. Ask AI for feedback when you want.')}</p><label for="feedbackDraft">${qaText?txt('检查识别文字，修改后再发送','Review and edit the transcript before sending'):txt('想补充什么？','Anything to add?')}</label><textarea id="feedbackDraft" rows="7" maxlength="12000" placeholder="${txt('我刚才说了什么？回看时注意到什么？下一次想试试什么？','What did I say? What did I notice when watching? What will I try next?')}">${esc(draft)}</textarea><div class="feedback-access access-wrap" ${api.requiresAccessCode?'':'hidden'}><label for="feedbackAccess">${txt('AI 访问码','AI access code')}</label><input id="feedbackAccess" type="password" autocomplete="off" value="${esc(accessCode)}"><button class="text-link" type="button" id="showFeedbackAccess">${txt('显示','Show')}</button></div><p class="coach-note">${txt('点“生成反馈”后，以上文字、主题和记录时的目标会发送给 DeepSeek。','Generate feedback sends this text, topic and the goal for this recording to DeepSeek.')}</p><div class="ai-actions"><button class="btn" id="saveFeedbackDraft">${txt('保存文字日记','Save written reflection')}</button><button class="btn solid" id="generateFeedback">${txt('生成反馈','Generate feedback')}</button></div><p class="feedback-status" role="status" aria-live="polite"></p><div class="feedback-output">${feedbackHTML(entry.coachFeedback)}</div></div>`;
    this.el.append(section);
    const status=$('.feedback-status',section),draftInput=$('#feedbackDraft',section),generate=$('#generateFeedback',section),save=$('#saveFeedbackDraft',section);
    async function update(fields){const fresh=await DB.tx('entries','readonly',st=>st.get(entry.id));if(!fresh)throw new Error(txt('记录已不存在。','This entry no longer exists.'));await DB.put({...fresh,...fields});Object.assign(entry,fields);core.invalidateEntries();}
    $('#feedbackAccess',section).oninput=e=>{accessCode=e.target.value;$('#coachAccess').value=accessCode;};
    $('#showFeedbackAccess',section).onclick=e=>{const input=$('#feedbackAccess',section);input.type=input.type==='password'?'text':'password';e.target.textContent=input.type==='password'?txt('显示','Show'):txt('隐藏','Hide');};
    save.onclick=async()=>{save.disabled=true;try{await update({feedbackDraft:draftInput.value});status.textContent=txt('文字日记已保存在当前浏览器，没有发送给 AI。','Written reflection saved in this browser; nothing was sent to AI.');}catch(e){status.textContent=txt('保存失败：','Could not save: ')+e.message;}finally{save.disabled=false;}};
    generate.onclick=async()=>{
      const text=draftInput.value.trim();
      if(!text){status.textContent=txt('先写下几句复盘，再生成反馈。','Write a reflection before generating feedback.');draftInput.focus();return;}
      if(text.length>6000){status.textContent=txt('AI 每次最多分析 6000 字。请缩短后再发送；完整日记仍可保存到本地。','AI accepts up to 6,000 characters. Shorten the text before sending; you can still save the full reflection locally.');draftInput.focus();return;}
      if(statusKnown&&!api.available){status.textContent=txt('AI 暂不可用。你可以先保存文字日记。','AI is unavailable. You can save your written reflection.');return;}
      if(api.requiresAccessCode&&!accessCode.trim()){status.textContent=txt('请先填写 AI 访问码。','Please enter the AI access code.');$('#feedbackAccess',section).focus();return;}
      generate.disabled=true;save.disabled=true;status.textContent=txt('正在生成文字反馈…','Generating text feedback…');
      try{
        await update({feedbackDraft:text});
        const result=await request({action:'feedback',text,topic:entry.coach?.topic||'daily',goal:entry.coach?.goal||'',lang:entry.lang||core.getLang()});
        const f=result.feedback;
        if(!f||typeof f.summary!=='string'||!Array.isArray(f.observations)||f.observations.some(x=>typeof x!=='string')||typeof f.nextStep!=='string')throw new Error(txt('反馈格式不完整，请重试。','The feedback was incomplete. Please try again.'));
        await update({coachFeedback:{summary:f.summary.slice(0,2400),observations:f.observations.slice(0,8).map(x=>x.slice(0,1200)),nextStep:f.nextStep.slice(0,1600)},coachFeedbackAt:Date.now(),coachFeedbackText:text});
        $('.feedback-output',section).innerHTML=feedbackHTML(entry.coachFeedback);status.textContent=txt('DeepSeek 文字反馈已保存，仅供你继续思考。','DeepSeek text feedback saved as a starting point for reflection.');
      }catch(e){status.textContent=e.message+' '+txt('输入的文字还在，可复制备份后重试。','Your text is still in the editor. Copy it as a backup and try again.');}
      finally{generate.disabled=false;save.disabled=false;}
    };
  };
  if (location.hostname === 'baidou.cam') {
    const oldSite = document.createElement('p');
    oldSite.className = 'old-records';
    oldSite.innerHTML = '<a href="https://cam.baidou.work/app/">旧站记录 ↗</a><span>新域名不会自动同步旧记录，可到旧站下载。</span>';
    oldSite.querySelector('span').remove();$('#view-cal').append(oldSite);
  }
  render();
  (async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{const r=await fetch('/api/coach/status',{signal:controller.signal,cache:'no-store'});if(!r.ok)throw new Error('status');const data=await r.json();api={available:data.available===true,requiresAccessCode:data.requiresAccessCode===true};}catch(_){api={available:false,requiresAccessCode:false};}finally{clearTimeout(timer);statusKnown=true;$('#coachService').textContent=statusText();$('.access-wrap',prep).hidden=!api.requiresAccessCode;document.querySelectorAll('.feedback-access').forEach(e=>{e.hidden=!api.requiresAccessCode;});}
  })();
};
