/* Personal AI setup and one contextual second turn. Provider keys stay on the server. */
window.initPersonalJournal = function (core) {
  'use strict';
  const {S, session, ui, audio, DB} = core;
  const $ = s => document.querySelector(s);
  const t = (zh, en) => core.getLang() === 'zh' ? zh : en;
  S.personalCaptions ??= true;
  S.personalFollowup ??= true;
  if (!S.personalGuideVersion) { S.autoAdvanceSec = 0; S.personalGuideVersion = 1; core.saveSettings(); }
  session.usePersonalAssistant = true;
  const assistant = core.assistant = {status: {state: 'checking'}, asked: false, chunks: [], length: 0, controller: null, ticket: 0};
  const panel = document.createElement('details');
  panel.id = 'personalAI'; panel.className = 'personal-ai';
  panel.innerHTML = '<summary><span id="personalAITitle"></span><span id="personalAIBadge"></span></summary><div class="personal-ai-body"><p id="personalAIHelp"></p><label for="personalAccess" id="personalAccessLabel"></label><div class="personal-access-row"><input id="personalAccess" type="password" autocomplete="off" spellcheck="false"><button class="btn" id="savePersonalAccess" type="button"></button></div><div class="personal-switches"><label><input id="personalCaptions" type="checkbox"><span id="personalCaptionsLabel"></span></label><label><input id="personalFollowup" type="checkbox"><span id="personalFollowupLabel"></span></label></div><p id="personalAIPrivacy"></p></div>';
  $('#recordFeedback').after(panel);
  const notice = document.createElement('p'); notice.id = 'personalStatus'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const skip = document.createElement('button'); skip.id = 'skipPersonalFollowup'; skip.className = 'subtle-button'; skip.type = 'button'; skip.hidden = true;
  $('.controls').after(notice, skip);
  core.getAIAccessCode = () => core.coach.getAccessCode();
  core.openAISettings = () => { core.showView('rec'); panel.open = true; panel.scrollIntoView({block:'center', behavior:'smooth'}); $('#personalAccess').focus(); };
  const status = (state, message = '', question = '') => {
    assistant.status = {state, message, question};
    document.dispatchEvent(new CustomEvent('cam:assistant-status'));
    window.dispatchEvent(new CustomEvent('cam:assistant-status'));
    core.syncExpression?.(); render();
  };
  const available = () => core.coach.status().available && core.coach.status().transcriptionAvailable
    && (!core.coach.status().requiresAccessCode || !!core.getAIAccessCode().trim());
  assistant.available = available;
  function render() {
    const config = core.coach.status(), busy = session.phase !== 'idle';
    $('#personalAITitle').textContent = t('AI 陪你说', 'AI companion');
    $('#personalAIBadge').textContent = available() ? t('已开启', 'Enabled') : !config.known ? t('连接中', 'Connecting') : config.requiresAccessCode && !core.getAIAccessCode() ? t('输入访问码', 'Enter access code') : t('暂未连接', 'Unavailable');
    $('#personalAIHelp').textContent = t('输入一次访问码，本次浏览器会话内可用。默认问题随时可以直接录。', 'Enter your code once for this browser session. The guiding questions always work.');
    $('#personalAccessLabel').textContent = t('你的 AI 访问码', 'Your AI access code');
    $('#personalAccess').placeholder = t('粘贴访问码', 'Paste access code');
    if (document.activeElement !== $('#personalAccess')) $('#personalAccess').value = core.getAIAccessCode();
    $('#savePersonalAccess').textContent = t('启用', 'Enable');
    $('#personalCaptionsLabel').textContent = t('录完自动生成字幕', 'Create captions after recording');
    $('#personalFollowupLabel').textContent = t('第一轮后追问一次', 'Ask one follow-up after my first answer');
    $('#personalAIPrivacy').textContent = t('开启后，语音会发送给阿里云识别，文字交给 DeepSeek 追问。临时音频处理后删除，视频留在本机。', 'When enabled, audio goes to Alibaba Cloud for transcription and text to DeepSeek for a follow-up. Temporary audio is deleted after processing; videos stay here.');
    $('#personalCaptions').checked = S.personalCaptions !== false;
    $('#personalFollowup').checked = S.personalFollowup !== false;
    panel.querySelectorAll('input,button').forEach(n => n.disabled = busy);
    notice.textContent = assistant.status.message || '';
    skip.hidden = !session.waitingForAI;
    skip.textContent = t('跳过追问，继续说', 'Skip and keep talking');
    if (session.waitingForAI) $('#btnNext').disabled = true;
  }
  $('#savePersonalAccess').onclick = async () => {
    const value = $('#personalAccess').value.trim(), button=$('#savePersonalAccess');
    if(!value){status('unavailable',t('请先粘贴访问码。','Paste your access code first.'));return;}
    button.disabled=true;
    try{
      const response=await fetch('/api/coach/access',{headers:{Authorization:'Bearer '+value},signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error(response.status===401?t('访问码不正确，请检查后重试。','Incorrect access code. Please check and retry.'):t('暂时无法验证访问码，请稍后重试。','Could not verify the access code. Please try again.'));
      core.coach.setAccessCode(value);await core.coach.refreshStatus();
      status(available()?'ready':'unavailable',available()?t('AI 已开启。开始录制后，它会在第一轮结束时接着问。','AI is ready and will follow up after your first answer.'):t('访问码已验证，字幕服务暂未就绪。默认问题仍可使用。','Access verified. Captions are not ready yet; guiding questions are available.'));
      if(available())panel.open=false;
    }catch(e){status('unavailable',e.name==='TimeoutError'?t('验证超时，请重试。','Verification timed out. Please retry.'):e.message);}
    finally{button.disabled=false;}
  };
  $('#personalAccess').addEventListener('keydown', e => { if (e.key === 'Enter') {e.preventDefault(); $('#savePersonalAccess').click();} });
  for (const key of ['personalCaptions','personalFollowup']) $('#'+key).onchange = e => {S[key] = e.target.checked; core.saveSettings(); render(); core.syncExpression?.();};
  const clearAudio = () => {assistant.chunks = []; assistant.length = 0;};
  session.onPCM = samples => {
    if (session.phase !== 'recording' || session.thinking || session.diary || assistant.asked || S.personalFollowup === false || !available()) return;
    if (assistant.length >= audio.sr * 600) return;
    const chunk = new Float32Array(samples.subarray(0, Math.max(0,Math.floor(audio.sr*600-assistant.length)))); assistant.chunks.push(chunk); assistant.length += chunk.length;
  };
  const start = session.startRecording;
  session.startRecording = function (...args) {
    assistant.ticket++; assistant.controller?.abort(); assistant.asked = false; clearAudio(); this.waitingForAI = false;
    this.personalCaptions = S.personalCaptions !== false && available();
    const result = start.apply(this,args);
    status(available() ? 'ready' : 'unavailable', !available() && (S.personalCaptions || S.personalFollowup) ? t('当前使用默认问题。录完后可在「AI 陪你说」中启用字幕和追问。', 'Using guiding questions. Enable captions and follow-ups in AI companion.') : '');
    return result;
  };
  const advance = session.advance;
  function releaseWait() {
    session.waitingForAI = false; session.thinking = false; session.lastVoice = performance.now();
    ui.thinking(false); ui.recording(session.phase === 'recording'); render();
  }
  session.advance = async function (...args) {
    if (this.phase !== 'recording' || this.thinking || this.diary) return;
    if (S.personalFollowup === false || !available() || assistant.asked || this.qi !== 0) {status(available()?'ready':'unavailable');return advance.apply(this,args);}
    if (assistant.length < audio.sr * 0.6) {status('ready', t('先说几句，再点“这段说完了”。也可以直接结束保存。', 'Say a few words first, then finish this answer. You can also save now.')); return;}
    assistant.asked = true;
    const ticket = ++assistant.ticket, controller = new AbortController(); assistant.controller = controller;
    const wav = core.encodeWav16k(assistant.chunks, assistant.length, audio.sr), durationMs = assistant.length / audio.sr * 1000;
    clearAudio(); this.thinking = true; this.waitingForAI = true; core.cancelSpeech(); ui.thinking(true);
    status('transcribing', t('正在听懂你刚才的话… 可以跳过，不影响保存。', 'Transcribing your answer… You can skip and keep your recording.'));
    try {
      const result = await core.captions.transcribeBlob(wav,{signal:controller.signal,accessCode:core.getAIAccessCode(),durationMs,lang:core.getLang()});
      if (ticket !== assistant.ticket || this.phase !== 'recording') return;
      const text = result.text?.trim();
      if (!text) throw new Error(t('这段没有识别到清楚的语音，先接着默认问题说。', 'No clear speech was found. Continue with the guiding question.'));
      this.transcript = text; await this.closeAnswer();
      status('thinking', t('正在顺着你的回答想一个问题…', 'Finding a question from your answer…'));
      const response = await core.coach.request({action:'followup',text:text.slice(0,6000),question:this.q,topic:S.coach.topic,style:S.coach.style,goal:S.coach.goal,lang:core.getLang()},{signal:controller.signal});
      if (ticket !== assistant.ticket || this.phase !== 'recording') return;
      if (typeof response.question !== 'string' || !response.question.trim()) throw new Error(t('这次没有生成追问，继续默认问题。','No follow-up this time. Continue with the guiding question.'));
      this.qs.splice(this.qi+1,0,response.question.trim()); this.qi++; this.aiCount++;
      releaseWait(); this.ask(response.question.trim());
      status('followup', t('这是根据你刚才的话接着问的。想说多少都可以。', 'A follow-up to what you just said. Share as much as you like.'),response.question.trim());
    } catch (e) {
      if (ticket !== assistant.ticket || this.phase !== 'recording') return;
      releaseWait();
      status('ready', e.name === 'AbortError' ? t('已跳过，继续说就好。','Skipped. Keep talking.') : e.message);
      await advance.apply(this,args);
    } finally { if (ticket === assistant.ticket) {assistant.controller = null; if (this.waitingForAI) releaseWait();} }
  };
  skip.onclick = async () => {
    assistant.ticket++; assistant.controller?.abort(); assistant.controller = null; releaseWait();
    status('ready',t('已跳过追问。接着默认问题说，或结束保存。','Follow-up skipped. Keep going or save.'));
    await advance.call(session);
  };
  const finish = session.finish;
  session.finish = function (...args) {assistant.ticket++; assistant.controller?.abort(); assistant.controller = null; this.waitingForAI = false; clearAudio(); return finish.apply(this,args);};
  session.onEntrySaved = entry => { if (entry.autoCaptions && available()) core.captions.processEntry(entry).catch(e => ui.status(e.message,true)); };
  const reset = session.reset;
  session.reset = function (...args) {const result = reset.apply(this,args); this.waitingForAI=false; clearAudio(); status(available()?'ready':'unavailable'); return result;};
  document.addEventListener('cam:coach-status',()=> {if(session.phase==='idle') status(available()?'ready':'unavailable');});
  new MutationObserver(render).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  render();
};
