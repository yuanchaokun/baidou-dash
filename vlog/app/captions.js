/* Private journal captions. Only extracted audio goes to the authenticated ASR service.
 * The trimmed source and original recording are never overwritten. */
(function () {
  'use strict';
  const SAMPLE_RATE = 16000, MAX_SECONDS = 600, MAX_WAV_BYTES = 20 * 1024 * 1024;
  const MAX_SOURCE_BYTES = 180 * 1024 * 1024;
  const abortError = () => new DOMException('Cancelled', 'AbortError');
  function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      const timer = setTimeout(done, ms);
      function done() { signal?.removeEventListener('abort', aborted); resolve(); }
      function aborted() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(abortError()); }
      signal?.addEventListener('abort', aborted, {once:true});
    });
  }
  function pcmWav(samples) {
    const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
    const write = (offset, value) => { for (let i=0;i<value.length;i++) view.setUint8(offset+i,value.charCodeAt(i)); };
    write(0,'RIFF'); view.setUint32(4,36+samples.length*2,true); write(8,'WAVE'); write(12,'fmt ');
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
    view.setUint32(24,SAMPLE_RATE,true); view.setUint32(28,SAMPLE_RATE*2,true);
    view.setUint16(32,2,true); view.setUint16(34,16,true); write(36,'data'); view.setUint32(40,samples.length*2,true);
    for (let i=0;i<samples.length;i++) { const s=Math.max(-1,Math.min(1,samples[i])); view.setInt16(44+i*2,s<0?s*32768:s*32767,true); }
    return new Blob([buffer],{type:'audio/wav'});
  }
  function wavInfo(buffer) {
    if (buffer.byteLength<44) return null;
    const v=new DataView(buffer), tag=(i,n)=>String.fromCharCode(...new Uint8Array(buffer,i,n));
    if(tag(0,4)!=='RIFF'||tag(8,4)!=='WAVE')return null;
    let fmt=null,dataBytes=0;
    for(let p=12;p+8<=buffer.byteLength;){
      const name=tag(p,4), size=v.getUint32(p+4,true); if(p+8+size>buffer.byteLength)return null;
      if(name==='fmt '&&size>=16)fmt={format:v.getUint16(p+8,true),channels:v.getUint16(p+10,true),rate:v.getUint32(p+12,true),bits:v.getUint16(p+22,true)};
      if(name==='data')dataBytes+=size;
      p+=8+size+(size%2);
    }
    if(!fmt||!dataBytes)return null;
    return {...fmt,dataBytes,duration:dataBytes/(fmt.rate*fmt.channels*(fmt.bits/8))};
  }
  function normalizeSegments(raw,duration=MAX_SECONDS) {
    if(!Array.isArray(raw))return [];
    const max=Math.min(MAX_SECONDS,Number.isFinite(duration)&&duration>0?duration:MAX_SECONDS);
    return raw.slice(0,5000).map(s=>({start:Number(s.start),end:Number(s.end),text:String(s.text||'').replace(/\s+/g,' ').trim().slice(0,2000)}))
      .filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.start>=0&&s.start<max&&s.end>s.start&&s.text)
      .map(s=>({...s,end:Math.min(s.end,max)})).sort((a,b)=>a.start-b.start);
  }
  function subtitleCues(segments) {
    const cues=[];
    for(const segment of segments){
      const limit=/[\u3400-\u9fff]/.test(segment.text)?30:68;
      const words=/[\u3400-\u9fff]/.test(segment.text)?Array.from(segment.text):segment.text.split(/(?<=\s)/);
      const parts=[];let current='';
      for(const word of words){if(current&&current.length+word.length>limit){parts.push(current.trim());current='';}current+=word;}
      if(current.trim())parts.push(current.trim());
      const count=parts.reduce((n,s)=>n+s.length,0);let cursor=segment.start;
      parts.forEach((text,i)=>{const end=i===parts.length-1?segment.end:cursor+(segment.end-segment.start)*text.length/count;cues.push({start:cursor,end,text});cursor=end;});
    }
    return cues;
  }
  function srtTime(seconds) {
    const ms=Math.max(0,Math.round(seconds*1000));
    return [Math.floor(ms/3600000),Math.floor(ms/60000)%60,Math.floor(ms/1000)%60].map(n=>String(n).padStart(2,'0')).join(':')+','+String(ms%1000).padStart(3,'0');
  }
  function toSrt(segments){return subtitleCues(segments).map((s,i)=>`${i+1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join('\n');}

  window.initJournalCaptions = function (core) {
    if(core.captions)return core.captions;
    const {DB,detail}=core, tasks=new Map(), exports=new Map();
    const txt=(cn,en)=>core.getLang()==='zh'?cn:en;
    const $=(selector,root=document)=>root.querySelector(selector);
    let shown=null, playbackCleanup=()=>{};
    const accessCode=options=>String(options?.accessCode??core.getAIAccessCode?.()??'').trim();
    const message=e=>e?.name==='AbortError'?txt('已取消，原视频仍然保留。','Cancelled. Your original video is safe.'):String(e?.message||txt('处理失败，请重试。','Processing failed. Please try again.')).slice(0,360);
    const durationOf=entry=>(entry.shareBlob?.size?entry.shareMs:entry.origMs)/1000;
    function validateDuration(seconds){if(!Number.isFinite(seconds)||seconds<=0||seconds>MAX_SECONDS+0.05)throw new Error(txt('自动字幕目前支持 10 分钟以内的视频，原视频可以照常下载。','Automatic captions support recordings up to 10 minutes. You can still download the original.'));}

    async function audioWav(blob,options={}) {
      checkAbort(options.signal);
      if(!blob?.size)throw new Error(txt('没有可以识别的音频。','There is no audio to transcribe.'));
      if(blob.size>MAX_SOURCE_BYTES)throw new Error(txt('这段视频较大，请先下载保留，再用较短的片段生成字幕。','This video is too large. Download it first, then use a shorter recording for captions.'));
      if(options.durationMs)validateDuration(options.durationMs/1000);
      options.onProgress?.({stage:'extracting',message:txt('正在从视频提取音频…','Extracting audio from your video…')});
      let encoded=await blob.arrayBuffer();checkAbort(options.signal);
      if(/(?:wav|wave)/i.test(blob.type)){
        const info=wavInfo(encoded);
        if(info?.format===1&&info.channels===1&&info.rate===SAMPLE_RATE&&info.bits===16){
          validateDuration(info.duration);
          if(encoded.byteLength>MAX_WAV_BYTES)throw new Error(txt('音频超过处理上限。','Audio exceeds the processing limit.'));
          return {blob:new Blob([encoded],{type:'audio/wav'}),duration:info.duration};
        }
      }
      const AC=window.AudioContext||window.webkitAudioContext;
      if(!AC)throw new Error(txt('当前浏览器不能提取音频。视频已保留，请用最新版 Safari 或 Chrome 重试。','This browser cannot extract audio. Your video is safe; try an up-to-date Safari or Chrome.'));
      let context,decoded;
      try{context=new AC({sampleRate:SAMPLE_RATE});decoded=await context.decodeAudioData(encoded);}
      catch(e){checkAbort(options.signal);throw new Error(txt('这个浏览器暂时无法读取视频里的音频。原片已保留，可换 Chrome 重试。','This browser could not read the audio in this video. Your original is safe; try Chrome.'));}
      finally{encoded=null;if(context&&context.state!=='closed')await context.close().catch(()=>{});}
      checkAbort(options.signal);validateDuration(decoded.duration);
      const length=Math.round(decoded.duration*SAMPLE_RATE), samples=new Float32Array(length),channels=[];
      for(let c=0;c<decoded.numberOfChannels;c++)channels.push(decoded.getChannelData(c));
      if(!channels.length)throw new Error(txt('视频中没有音轨。','This video has no audio track.'));
      const ratio=decoded.sampleRate/SAMPLE_RATE;
      for(let start=0;start<length;start+=65536){
        checkAbort(options.signal);
        for(let i=start;i<Math.min(start+65536,length);i++){
          const p=i*ratio, a=Math.floor(p), b=Math.min(a+1,decoded.length-1), mix=p-a;
          let value=0;for(const channel of channels)value+=(channel[a]||0)*(1-mix)+(channel[b]||0)*mix;
          samples[i]=value/channels.length;
        }
        if(start)await sleep(0,options.signal);
      }
      const wav=pcmWav(samples);if(wav.size>MAX_WAV_BYTES)throw new Error(txt('音频超过处理上限。','Audio exceeds the processing limit.'));
      return {blob:wav,duration:decoded.duration};
    }

    async function apiRequest(url,init,signal) {
      checkAbort(signal);
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
      const aborted=()=>controller.abort();signal?.addEventListener('abort',aborted,{once:true});
      try{
        const response=await fetch(url,{...init,signal:controller.signal,cache:'no-store'});
        let data;try{data=await response.json();}catch(_){throw new Error(txt('字幕服务返回了无效结果，请稍后重试。','The caption service returned an invalid response. Please try again.'));}
        if(!response.ok){
          const fallback={401:txt('AI 访问码不正确，请重新填写。','Please check your AI access code.'),413:txt('音频超过 10 分钟的处理上限。','Audio exceeds the 10-minute limit.'),429:txt('请求较多，请稍后重试。','Too many requests. Please try later.'),503:txt('字幕服务还未配置，请先下载视频，稍后可重试。','The caption service is not configured. Download your video first and try later.')};
          const error=new Error(fallback[response.status]||data?.error?.message||txt('字幕生成失败，请稍后重试。','Caption generation failed. Please try again.'));
          error.status=response.status;error.code=String(data?.error?.code||'');throw error;
        }
        return data;
      }catch(e){if(signal?.aborted)throw abortError();if(e.name==='AbortError')throw new Error(txt('字幕服务等待超时，可稍后重试。','The caption service timed out. You can retry later.'));throw e;}
      finally{clearTimeout(timer);signal?.removeEventListener('abort',aborted);}
    }
    async function pollJob(job,options) {
      const started=Date.now(), code=accessCode(options);
      while(Date.now()-started<240000){
        checkAbort(options.signal);
        await sleep(Math.max(1000,Math.min(6000,Number(job.pollAfterMs)||1500)),options.signal);
        job=await apiRequest('/api/transcribe?job='+encodeURIComponent(job.jobId),{headers:{Authorization:'Bearer '+code,'X-Transcription-Token':job.jobToken||options.jobToken}},options.signal).then(data=>({...job,...data}));
        if(job.status==='completed')return job;
        if(job.status!=='pending')throw new Error(txt('字幕任务没有正常完成，请重试。','The caption job did not complete. Please retry.'));
      }
      throw new Error(txt('字幕仍在处理中。可稍后点“继续生成”，原视频已保留。','Captions are still processing. Try “Continue captions” later; your original video is safe.'));
    }
    async function transcribeBlob(blob,options={}) {
      if(!accessCode(options))throw new Error(txt('先填写 AI 访问码，再生成字幕。','Enter your AI access code to generate captions.'));
      const audio=await audioWav(blob,options);checkAbort(options.signal);
      options.onProgress?.({stage:'uploading',message:txt('正在上传音频生成字幕，视频保留在本机…','Uploading audio for captions. Your video stays on this device…')});
      let data=await apiRequest('/api/transcribe',{method:'POST',headers:{'Content-Type':'audio/wav',Authorization:'Bearer '+accessCode(options)},body:audio.blob},options.signal);
      if(data.status==='pending'){
        if(!data.jobId||!data.jobToken)throw new Error(txt('字幕任务缺少凭证，请重试。','The caption job is missing its credentials. Please retry.'));
        await options.onJob?.({...data,duration:audio.duration});
        options.onProgress?.({stage:'transcribing',message:txt('正在识别你说的话…','Transcribing what you said…')});
        data=await pollJob(data,options);
      }
      if(data.status!=='completed')throw new Error(txt('字幕任务尚未完成，请重试。','The caption job is not complete. Please retry.'));
      return {text:String(data.text||'').slice(0,60000),segments:normalizeSegments(data.segments,audio.duration),duration:audio.duration};
    }
    async function persist(entry,patch) {
      const fresh=await DB.tx('entries','readonly',store=>store.get(entry.id));
      if(!fresh)throw new Error(txt('这条记录已删除，处理已停止。','This entry was deleted. Processing stopped.'));
      const next={...fresh,...patch};await DB.put(next);Object.assign(entry,next);core.invalidateEntries?.();
      if(shown?.entry.id===entry.id)Object.assign(shown.entry,next);
      return next;
    }
    function updateStatus(entry,state) {
      const task=tasks.get(entry.id)||exports.get(entry.id);if(task)Object.assign(task,state);
      if(shown?.entry.id===entry.id)renderPanel(shown.entry);
    }
    async function processEntry(entry,options={}) {
      checkAbort(options.signal);
      if(tasks.has(entry.id))return tasks.get(entry.id).promise;
      if(entry.captions?.status==='ready'&&!options.force)return entry;
      const controller=new AbortController(), abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
      const task={controller,stage:'extracting',message:txt('正在准备字幕…','Preparing captions…')};tasks.set(entry.id,task);
      task.promise=(async()=>{
        try{
          const previous=entry.captions||{};
          await persist(entry,{captions:{...previous,version:1,status:'processing',error:'',source:entry.shareBlob?.size?'share':'orig'}});
          updateStatus(entry,{});
          const requestOptions={...options,signal:controller.signal,onProgress:state=>{updateStatus(entry,state);options.onProgress?.(state);},onJob:async job=>{await persist(entry,{captions:{...entry.captions,jobId:job.jobId,jobToken:job.jobToken,jobAt:Date.now(),duration:job.duration}});}};
          let result;
          if(!options.force&&previous.jobId&&previous.jobToken&&Date.now()-Number(previous.jobAt)<50*60000){
            if(!accessCode(options))throw new Error(txt('先填写 AI 访问码，再继续生成字幕。','Enter your AI access code to continue generating captions.'));
            updateStatus(entry,{stage:'transcribing',message:txt('正在继续获取字幕…','Retrieving captions…')});
            try{const data=await pollJob(previous,requestOptions);result={text:String(data.text||'').slice(0,60000),segments:normalizeSegments(data.segments,previous.duration||durationOf(entry)),duration:previous.duration||durationOf(entry)};}
            catch(e){if(e.status!==404&&e.status!==410)throw e;}
          }
          if(!result)result=await transcribeBlob(entry.shareBlob?.size?entry.shareBlob:entry.origBlob,{...requestOptions,durationMs:entry.shareBlob?.size?entry.shareMs:entry.origMs});
          checkAbort(controller.signal);
          const status=result.segments.length?'ready':result.text.trim()?'untimed':'empty';
          await persist(entry,{captions:{version:1,status,text:result.text,segments:result.segments,duration:result.duration,source:entry.shareBlob?.size?'share':'orig',generatedAt:Date.now()},...(options.force?{captionedBlob:null,captionedAt:null}:{} )});
          if(shown?.entry.id===entry.id)attachPlayback(shown.entry);
          return entry;
        }catch(e){
          const terminal=['transcription_failed','invalid_transcript'].includes(e.code);
          await persist(entry,{captions:{...entry.captions,...(terminal?{jobId:null,jobToken:null,jobAt:null}:{}),status:e.name==='AbortError'?'cancelled':'error',error:message(e)}}).catch(()=>{});
          throw e;
        }finally{tasks.delete(entry.id);options.signal?.removeEventListener('abort',abort);if(shown?.entry.id===entry.id)renderPanel(shown.entry);}
      })();
      return task.promise;
    }

    function waitMedia(video,event,signal,timeout=20000) {
      return new Promise((resolve,reject)=>{
        checkAbort(signal);const timer=setTimeout(()=>done(new Error(txt('视频加载超时，请重试。','Video loading timed out. Please try again.'))),timeout);
        const okay=()=>done(),error=()=>done(new Error(txt('浏览器无法播放这段视频，原片可以照常下载。','This browser cannot play this video. You can still download the original.'))),aborted=()=>done(abortError());
        function done(e){clearTimeout(timer);video.removeEventListener(event,okay);video.removeEventListener('error',error);signal?.removeEventListener('abort',aborted);e?reject(e):resolve();}
        video.addEventListener(event,okay,{once:true});video.addEventListener('error',error,{once:true});signal?.addEventListener('abort',aborted,{once:true});
      });
    }
    function drawSubtitle(context,canvas,cue) {
      if(!cue)return;
      const width=canvas.width,height=canvas.height, fontSize=Math.max(18,Math.round(Math.min(width*0.052,height*0.035)));
      context.save();context.font=`600 ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`;
      const maxWidth=width*0.84, lines=[];let line='';
      for(const char of Array.from(cue.text)){if(line&&context.measureText(line+char).width>maxWidth){lines.push(line);line='';}line+=char;}
      if(line)lines.push(line);
      const lineHeight=fontSize*1.4,padding=fontSize*0.38, boxHeight=lineHeight*lines.length+padding*2;
      const y=height-height*0.065-boxHeight;
      context.fillStyle='rgba(12,15,18,0.74)';
      const boxWidth=Math.min(width*0.92,Math.max(...lines.map(l=>context.measureText(l).width))+padding*3);
      context.fillRect((width-boxWidth)/2,y,boxWidth,boxHeight);
      context.fillStyle='#fff';context.textAlign='center';context.textBaseline='middle';
      lines.forEach((l,i)=>context.fillText(l,width/2,y+padding+lineHeight*(i+0.5)));context.restore();
    }
    function recorderMime() {
      return ['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/webm'].find(type=>MediaRecorder.isTypeSupported(type))||'';
    }
    async function burnVideo(entry,options={}) {
      const AC=window.AudioContext||window.webkitAudioContext;
      if(!AC||!window.MediaRecorder||!HTMLCanvasElement.prototype.captureStream)throw new Error(txt('当前浏览器不能导出字幕视频。可以先下载原视频和 SRT 字幕文件。','This browser cannot export captioned video. Download the source video and SRT captions instead.'));
      if(document.hidden)throw new Error(txt('请回到这个页面后再导出字幕视频。','Return to this page before exporting your captioned video.'));
      const context=new AC();let resume=context.resume();
      const video=document.createElement('video'), canvas=document.createElement('canvas'), source=entry.shareBlob?.size?entry.shareBlob:entry.origBlob;
      const url=URL.createObjectURL(source);let stream,sourceNode,destination,recorder,animation=0,wakeLock,disposed=false;
      video.playsInline=true;video.preload='auto';video.setAttribute('playsinline','');
      video.style.cssText='position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1';video.setAttribute('aria-hidden','true');
      document.body.append(video);
      try{
        await resume;checkAbort(options.signal);
        if(context.state!=='running')throw new Error(txt('请再点一次“导出带字幕视频”，以启用声音处理。','Click “Export captioned video” again to enable audio processing.'));
        const loaded=waitMedia(video,'loadeddata',options.signal);video.src=url;video.load();await loaded;
        canvas.width=video.videoWidth;canvas.height=video.videoHeight;
        if(!canvas.width||!canvas.height)throw new Error(txt('没有读到视频尺寸，请重试。','The video dimensions could not be read. Please retry.'));
        const seconds=Number.isFinite(video.duration)?video.duration:entry.captions.duration||durationOf(entry);validateDuration(seconds);
        const paint=canvas.getContext('2d',{alpha:false});if(!paint)throw new Error(txt('无法创建字幕画布。','Could not create the caption canvas.'));
        paint.drawImage(video,0,0,canvas.width,canvas.height);
        const cues=subtitleCues(normalizeSegments(entry.captions.segments,seconds));
        stream=canvas.captureStream(30);destination=context.createMediaStreamDestination();sourceNode=context.createMediaElementSource(video);sourceNode.connect(destination);
        const audioTracks=destination.stream.getAudioTracks();if(!audioTracks.length)throw new Error(txt('无法保留音轨，字幕导出已停止。','Audio could not be preserved, so export was stopped.'));
        audioTracks.forEach(track=>stream.addTrack(track));
        const mime=recorderMime(),chunks=[];
        recorder=new MediaRecorder(stream,{...(mime?{mimeType:mime}:{}),videoBitsPerSecond:Math.max(1500000,Math.min(6000000,canvas.width*canvas.height*3)),audioBitsPerSecond:128000});
        let recordingBytes=0;
        recorder.ondataavailable=e=>{if(e.data.size){chunks.push(e.data);recordingBytes+=e.data.size;}};
        const result=new Promise((resolve,reject)=>{
          let failure=null,finished=false,timer;
          const hidden=()=>{if(document.hidden)stop(new Error(txt('页面进入后台，导出已停止以免丢帧。请保持页面打开后重试。','Export stopped because the page went into the background. Keep it open and retry.')));};
          const aborted=()=>stop(abortError());
          const mediaError=()=>stop(new Error(txt('播放中断，导出未完成；原视频仍在。','Playback was interrupted. Export did not finish; your source video is safe.')));
          const ended=()=>stop();
          function cleanup(){clearTimeout(timer);document.removeEventListener('visibilitychange',hidden);options.signal?.removeEventListener('abort',aborted);video.removeEventListener('ended',ended);video.removeEventListener('error',mediaError);}
          function stop(error){if(finished)return;finished=true;failure=error||null;video.pause();cleanup();if(recorder.state!=='inactive')recorder.stop();else finish();}
          function finish(){cleanup();if(failure)return reject(failure);const blob=new Blob(chunks,{type:recorder.mimeType||mime});if(!blob.size)return reject(new Error(txt('导出的视频为空，请重试。','The exported video was empty. Please retry.')));resolve(blob);}
          recorder.onstop=finish;recorder.onerror=e=>stop(new Error(e.error?.message||txt('视频编码失败。','Video encoding failed.')));
          video.addEventListener('ended',ended,{once:true});video.addEventListener('error',mediaError,{once:true});document.addEventListener('visibilitychange',hidden);options.signal?.addEventListener('abort',aborted,{once:true});
          timer=setTimeout(()=>stop(new Error(txt('导出等待过久，请保持页面打开后重试。','Export timed out. Keep this page open and retry.'))),seconds*1600+30000);
          let previous=-1;
          function frame(){
            if(finished)return;
            if(recordingBytes>MAX_SOURCE_BYTES){stop(new Error(txt('字幕视频超过本机导出上限，原片仍然保留。','The captioned video exceeds the local export limit. Your original is safe.')));return;}
            const time=video.currentTime;
            if(video.readyState>=2){paint.drawImage(video,0,0,canvas.width,canvas.height);drawSubtitle(paint,canvas,cues.find(c=>time>=c.start&&time<c.end));}
            const percent=Math.min(99,Math.floor(time/seconds*100));
            if(percent!==previous){previous=percent;options.onProgress?.({stage:'exporting',progress:percent,message:txt(`正在导出 ${percent}% · 请保持页面打开`,`Exporting ${percent}% · Keep this page open`)});}
            animation=requestAnimationFrame(frame);
          }
          checkAbort(options.signal);recorder.start(1000);frame();video.play().catch(mediaError);
        });
        if(navigator.wakeLock?.request)navigator.wakeLock.request('screen').then(lock=>{if(disposed)lock.release().catch(()=>{});else wakeLock=lock;}).catch(()=>{});
        return await result;
      }finally{
        disposed=true;cancelAnimationFrame(animation);video.pause();if(recorder&&recorder.state!=='inactive')recorder.stop();
        stream?.getTracks().forEach(track=>track.stop());sourceNode?.disconnect();destination?.disconnect();
        video.removeAttribute('src');video.load();video.remove();URL.revokeObjectURL(url);wakeLock?.release().catch(()=>{});await context.close().catch(()=>{});
      }
    }
    async function exportEntry(entry,options={}) {
      checkAbort(options.signal);
      if(exports.has(entry.id))return exports.get(entry.id).promise;
      if(entry.captions?.status!=='ready')throw new Error(txt('字幕生成完成后才能导出。','Generate captions before exporting.'));
      if(entry.captionedBlob?.size&&!options.force)return entry.captionedBlob;
      const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
      const task={controller,stage:'exporting',progress:0,message:txt('正在准备字幕视频…','Preparing captioned video…')};exports.set(entry.id,task);
      task.promise=(async()=>{
        try{
          const blob=await burnVideo(entry,{...options,signal:controller.signal,onProgress:state=>{updateStatus(entry,state);options.onProgress?.(state);}});
          checkAbort(controller.signal);await persist(entry,{captionedBlob:blob,captionedAt:Date.now(),captionExportError:''});return blob;
        }catch(e){await persist(entry,{captionExportError:message(e)}).catch(()=>{});throw e;}
        finally{exports.delete(entry.id);options.signal?.removeEventListener('abort',abort);if(shown?.entry.id===entry.id)renderPanel(shown.entry);}
      })();
      updateStatus(entry,{});return task.promise;
    }
    function download(blob,entry,ext,label) {
      const a=document.createElement('a'),url=URL.createObjectURL(blob);
      a.href=url;a.download=(entry.date||'journal')+'_'+String(entry.title||'video').replace(/[\\/:*?"<>|]/g,'').slice(0,80)+'_'+label+'.'+ext;
      document.body.append(a);a.click();setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},30000);
    }
    function attachPlayback(entry) {
      playbackCleanup();playbackCleanup=()=>{};
      const video=$('#vplay',detail.el);if(!video||entry.captions?.status!=='ready'||typeof window.VTTCue!=='function')return;
      const track=video.addTextTrack('captions',txt('中文字幕','Captions'),entry.lang||core.getLang());
      for(const cue of subtitleCues(entry.captions.segments)){const item=new VTTCue(cue.start,cue.end,cue.text);item.line=-3;track.addCue(item);}
      const shareSrc=$('#vseg [data-src]',detail.el)?.dataset.src||video.src;
      function sync(){track.mode=video.src===shareSrc?'showing':'disabled';}
      const observer=new MutationObserver(sync);observer.observe(video,{attributes:true,attributeFilter:['src']});sync();
      playbackCleanup=()=>{observer.disconnect();track.mode='disabled';while(track.cues?.length)track.removeCue(track.cues[0]);};
    }
    function statusFor(entry) {
      const task=tasks.get(entry.id)||exports.get(entry.id);if(task)return task.message;
      const status=entry.captions?.status;
      if(entry.captionExportError)return entry.captionExportError;
      if(entry.captionedBlob?.size)return txt('字幕视频已保存到本机，可直接下载。','Captioned video saved on this device and ready to download.');
      if(status==='ready')return txt('字幕已生成。导出时会把字幕写入视频，请保持页面打开。','Captions are ready. Export writes them into the video; keep this page open.');
      if(status==='empty')return txt('这段音频没有识别到说话内容，原视频已保留。','No speech was detected. Your original video is safe.');
      if(status==='untimed')return txt('已识别文字，但没有得到字幕时间轴。可以保存文字，或重新生成字幕。','Text was transcribed but timestamps are missing. Save the text or regenerate captions.');
      if(status==='error'||status==='cancelled')return entry.captions.error;
      if(status==='processing')return txt('上次处理尚未完成，可以继续生成字幕。','The previous caption task did not finish. You can continue it.');
      return accessCode()?txt('录完生成字幕；导出时把字幕写入视频。','Captions are generated after recording and written into the video on export.'):txt('填写 AI 访问码后，可以生成你说的话的字幕。','Enter your AI access code to caption what you said.');
    }
    function renderPanel(entry) {
      if(shown?.entry.id!==entry.id)return;
      const panel=shown.panel,task=tasks.get(entry.id)||exports.get(entry.id),busy=!!task,ready=entry.captions?.status==='ready';
      $('.caption-status',panel).textContent=statusFor(entry);
      const progress=$('progress',panel);progress.hidden=task?.stage!=='exporting';progress.value=task?.progress||0;
      const generate=$('[data-caption-generate]',panel),burn=$('[data-caption-export]',panel),cancel=$('[data-caption-cancel]',panel),srt=$('[data-caption-srt]',panel),code=$('[data-caption-code]',panel);
      generate.hidden=ready;generate.disabled=busy;generate.textContent=entry.captions?.jobId?txt('继续生成','Continue captions'):entry.captions?txt('重新生成字幕','Retry captions'):txt('生成字幕','Generate captions');
      burn.hidden=!ready;burn.disabled=busy;burn.textContent=entry.captionedBlob?.size?txt('下载带字幕视频','Download captioned video'):txt('导出带字幕视频','Export captioned video');
      cancel.hidden=!busy;srt.hidden=!ready;code.hidden=!!accessCode();code.disabled=busy;
      const transcript=$('[data-caption-transcript]',panel),text=$('.caption-transcript',panel);transcript.hidden=!entry.captions?.text;text.textContent=entry.captions?.text||'';
      $('.caption-export-note',panel).hidden=!ready||!!entry.captionedBlob?.size;
    }
    const originalDetail=detail.render;
    detail.render=function(entry,siblings){
      playbackCleanup();shown=null;originalDetail.call(this,entry,siblings);if(!entry)return;
      const panel=document.createElement('section');panel.className='caption-tools';
      const title=document.createElement('h3');title.textContent=txt('视频字幕','Video captions');panel.append(title);
      const status=document.createElement('p');status.className='caption-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');panel.append(status);
      const progress=document.createElement('progress');progress.max=100;progress.hidden=true;progress.setAttribute('aria-label',txt('字幕视频导出进度','Captioned video export progress'));panel.append(progress);
      const buttons=document.createElement('div');buttons.className='caption-actions';panel.append(buttons);
      for(const [key,label] of [['generate',txt('生成字幕','Generate captions')],['export',txt('导出带字幕视频','Export captioned video')],['cancel',txt('取消','Cancel')],['code',txt('填写 AI 访问码','Enter AI access code')]]){const button=document.createElement('button');button.type='button';button.className=key==='export'?'btn solid':'btn';button.dataset['caption'+key[0].toUpperCase()+key.slice(1)]='';button.textContent=label;buttons.append(button);}
      const note=document.createElement('p');note.className='caption-export-note';note.textContent=txt('导出大约需要视频本身的时长；原片和无字幕版本都会保留。','Export takes about the length of your video. Both source versions are preserved.');panel.append(note);
      const transcript=document.createElement('details');transcript.dataset.captionTranscript='';
      const summary=document.createElement('summary');summary.textContent=txt('识别文字与字幕文件','Transcript and caption file');transcript.append(summary);
      const text=document.createElement('p');text.className='caption-transcript';transcript.append(text);
      const srt=document.createElement('button');srt.type='button';srt.className='text-link';srt.dataset.captionSrt='';srt.textContent=txt('下载 SRT 字幕','Download SRT captions');transcript.append(srt);panel.append(transcript);
      const anchor=$('.download-video',this.el)||$('.player',this.el);if(anchor)anchor.after(panel);else this.el.append(panel);
      shown={entry,panel};
      $('[data-caption-code]',panel).onclick=()=>{core.openAISettings?.();};
      $('[data-caption-generate]',panel).onclick=()=>{processEntry(entry).catch(()=>{});};
      $('[data-caption-cancel]',panel).onclick=()=>{tasks.get(entry.id)?.controller.abort();exports.get(entry.id)?.controller.abort();};
      $('[data-caption-export]',panel).onclick=async()=>{try{const blob=await exportEntry(entry);download(blob,entry,/mp4/i.test(blob.type)?'mp4':'webm','captions');}catch(_){};};
      srt.onclick=()=>download(new Blob([toSrt(entry.captions.segments)],{type:'application/x-subrip;charset=utf-8'}),entry,'srt','captions');
      attachPlayback(entry);renderPanel(entry);
    };
    if(!document.getElementById('journalCaptionStyles')){
      const style=document.createElement('style');style.id='journalCaptionStyles';style.textContent='.caption-tools{margin:20px 0;padding:18px 0;border-top:1px solid var(--line,rgba(128,128,128,.22))}.caption-tools h3{font-size:15px;margin:0 0 8px}.caption-status,.caption-export-note{font-size:13px;line-height:1.7;margin:8px 0;color:var(--muted,inherit)}.caption-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.caption-tools progress{width:100%;height:6px;accent-color:var(--accent,#507354)}.caption-tools details{font-size:13px;margin-top:12px}.caption-tools summary{cursor:pointer}.caption-transcript{white-space:pre-wrap;line-height:1.9;max-height:260px;overflow:auto}.caption-tools [hidden]{display:none!important}@media(max-width:520px){.caption-actions .btn{min-height:44px;flex:1 1 auto}}';document.head.append(style);
    }
    core.captions={transcribeBlob,processEntry,exportEntry,cancel(id){tasks.get(id)?.controller.abort();exports.get(id)?.controller.abort();},refresh(){if(shown)renderPanel(shown.entry);}};
    return core.captions;
  };
})();
