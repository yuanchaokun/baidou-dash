import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../vlog/_worker.js', import.meta.url), 'utf8');
const {default: worker} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const CODE = 'test-personal-access';
const TASK = 'test-provider-task';
const RESULT = 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/transcript.json?Expires=123&Signature=example';
function wav(seconds = 2) {
  const bytes = new Uint8Array(44 + Math.round(seconds * 32000)), view = new DataView(bytes.buffer);
  const set = (offset, value) => bytes.set(new TextEncoder().encode(value), offset);
  set(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); set(8, 'WAVE'); set(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  set(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  return bytes;
}
class Bucket {
  objects = new Map();
  async put(key, input, options = {}) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
    this.objects.set(key, {bytes: bytes.slice(), options});
  }
  async get(key) {
    const entry = this.objects.get(key); if (!entry) return null;
    return {body: new Response(entry.bytes).body, size: entry.bytes.length, customMetadata: entry.options.customMetadata, text: async () => new TextDecoder().decode(entry.bytes)};
  }
  async delete(key) {this.objects.delete(key);}
  readJob(id) {return JSON.parse(new TextDecoder().decode(this.objects.get(`transcribe/jobs/${id}.json`).bytes));}
}
function env(overrides = {}) {
  return {DEEPSEEK_API_KEY: 'test-deepseek', DASHSCOPE_API_KEY: 'test-dashscope', DIARY_AUDIO_SIGNING_KEY: 'test-signing-key-at-least-32-characters',
    COACH_ACCESS_CODE: CODE, DIARY_AUDIO: new Bucket(), AI_LIMITS: {fetch: async () => Response.json({allowed: true})}, ...overrides};
}
function req(body = wav(), options = {}) {
  const {method = 'POST', path = '/api/transcribe', code = CODE, origin = 'https://baidou.cam', headers = {}} = options;
  return new Request('https://baidou.cam' + path, {method, headers: {Origin: origin, Authorization: `Bearer ${code}`, 'Content-Type': 'audio/wav', ...headers},
    ...(['GET', 'HEAD'].includes(method) ? {} : {body})});
}
function poll(job, overrides = {}) {return req(null, {method: 'GET', path: `/api/transcribe?job=${job.jobId}`, headers: {'X-Transcription-Token': job.jobToken}, ...overrides});}
const submitted = () => Response.json({output: {task_id: TASK, task_status: 'PENDING'}});
const completed = (result = RESULT) => Response.json({output: {task_id: TASK, task_status: 'SUCCEEDED', result: {transcription_url: result}}});
const transcript = () => Response.json({transcripts: [{channel_id: 0, text: '今天很开心。', sentences: [{begin_time: 250, end_time: 1750, text: '今天很开心。', words: [{begin_time: 250, end_time: 600, text: '今天'}]}]}]});
const uploadPolicy = (overrides = {}) => Response.json({data: {upload_host: 'https://dashscope-file-test.oss-cn-beijing.aliyuncs.com', upload_dir: 'dashscope-instant/test/2026-09-08/session',
  oss_access_key_id: 'test-upload-key', signature: 'test-signature', policy: 'test-policy', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true', expire_in_seconds: 300, max_file_size_mb: 100, ...overrides}});
async function withFetch(replacement, fn) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {calls.push([url, options]); return replacement(url, options, calls.length);};
  try {return await fn(calls);} finally {globalThis.fetch = original;}
}
async function start(e) {const response = await worker.fetch(req(), e); assert.equal(response.status, 202); return response.json();}

test('transcription fails closed for missing bindings, missing code, invalid code and external origin', async () => withFetch(submitted, async calls => {
  for (const patch of [{DASHSCOPE_API_KEY: ''}, {DIARY_AUDIO_SIGNING_KEY: ''}, {DIARY_AUDIO: undefined}, {AI_LIMITS: undefined}, {COACH_ACCESS_CODE: ''}]) {
    assert.equal((await worker.fetch(req(), env(patch))).status, 503);
  }
  for (const code of ['', 'wrong']) assert.equal((await worker.fetch(req(wav(), {code}), env())).status, 401);
  assert.equal((await worker.fetch(req(wav(), {origin: 'https://evil.example'}), env())).status, 403);
  assert.equal(calls.length, 0);
}));
test('transcription status reports availability without exposing keys', async () => {
  const response = await worker.fetch(req(null, {method: 'GET', path: '/api/coach/status'}), env());
  assert.deepEqual(await response.json(), {available: true, requiresAccessCode: true, transcriptionAvailable: true});
});
test('access validation accepts only owner code and spends no quota or provider call', async () => withFetch(submitted, async calls => {
  let reservations = 0;
  const e = env({AI_LIMITS: {fetch: async () => {reservations++; return Response.json({allowed: true});}}});
  const good = await worker.fetch(req(null, {method: 'GET', path: '/api/coach/access'}), e);
  assert.equal(good.status, 200); assert.deepEqual(await good.json(), {valid: true});
  assert.equal((await worker.fetch(req(null, {method: 'GET', path: '/api/coach/access', code: 'wrong'}), e)).status, 401);
  assert.equal((await worker.fetch(req(null, {method: 'GET', path: '/api/coach/access', origin: 'https://evil.example'}), e)).status, 403);
  assert.equal(reservations, 0); assert.equal(calls.length, 0);
}));
test('invalid content, bounded length, malformed WAV and overlong WAV spend nothing', async () => withFetch(submitted, async calls => {
  const e = env();
  assert.equal((await worker.fetch(req('abc', {headers: {'Content-Type': 'audio/webm'}}), e)).status, 415);
  assert.equal((await worker.fetch(req('abc', {headers: {'Content-Length': String(21 * 1024 * 1024)}}), e)).status, 413);
  assert.equal((await worker.fetch(req(new Uint8Array(21 * 1024 * 1024)), e)).status, 413);
  for (const bytes of [new Uint8Array(), new Uint8Array(100), wav().slice(0, -1)]) assert.equal((await worker.fetch(req(bytes), e)).status, 400);
  const stereo = wav(); new DataView(stereo.buffer).setUint16(22, 2, true);
  assert.equal((await worker.fetch(req(stereo), e)).status, 400);
  assert.equal((await worker.fetch(req(wav(601)), e)).status, 413);
  assert.equal(calls.length, 0); assert.equal(e.DIARY_AUDIO.objects.size, 0);
}));
test('quota rejection happens before temporary upload or paid request', async () => withFetch(submitted, async calls => {
  const e = env({AI_LIMITS: {fetch: async () => new Response('', {status: 429})}});
  assert.equal((await worker.fetch(req(), e)).status, 429); assert.equal(calls.length, 0); assert.equal(e.DIARY_AUDIO.objects.size, 0);
}));
test('provider-local temporary upload uses private model-bound policy and file-last form without a public audio copy', async () => withFetch((url, options, n) => n === 1 ? uploadPolicy() : n === 2 ? new Response('') : submitted(), async calls => {
  const e = env({ASR_UPLOAD_MODE: 'dashscope-temporary', DIARY_AUDIO_SIGNING_KEY: undefined}), job = await start(e);
  assert.equal(calls[0][0], 'https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3-asr-flash-filetrans');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer test-dashscope');
  const [uploadURL, upload] = calls[1];
  assert.equal(uploadURL, 'https://dashscope-file-test.oss-cn-beijing.aliyuncs.com/'); assert.equal(upload.redirect, 'manual'); assert.equal(upload.headers, undefined);
  assert.ok(upload.body instanceof FormData); const fields = Array.from(upload.body.keys()); assert.equal(fields.at(-1), 'file');
  assert.equal(upload.body.get('x-oss-object-acl'), 'private'); assert.equal(upload.body.get('x-oss-forbid-overwrite'), 'true');
  assert.equal(upload.body.get('file').size, wav().byteLength); assert.equal(upload.body.get('file').name, job.jobId + '.wav');
  const model = JSON.parse(calls[2][1].body);
  assert.equal(model.model, 'qwen3-asr-flash-filetrans'); assert.equal(model.input.file_url, 'oss://dashscope-instant/test/2026-09-08/session/' + job.jobId + '.wav');
  assert.equal(calls[2][1].headers['X-DashScope-OssResourceResolve'], 'enable');
  assert.equal(e.DIARY_AUDIO.objects.size, 1); assert.equal(e.DIARY_AUDIO.readJob(job.jobId).uploadMode, 'dashscope-temporary');
  assert.ok(!JSON.stringify(e.DIARY_AUDIO.readJob(job.jobId)).includes('oss://'));
}));
test('provider-local upload rejects public ACL, arbitrary hosts, redirects, directory escapes and undersized policy', async () => {
  for (const patch of [{upload_host:'http://dashscope-file-test.oss-cn-beijing.aliyuncs.com'}, {upload_host:'https://evil.example/'}, {upload_host:'https://dashscope-file-test.oss-cn-beijing.aliyuncs.com/path'},
    {upload_host:'https://user@dashscope-file-test.oss-cn-beijing.aliyuncs.com'}, {x_oss_object_acl:'public-read'}, {x_oss_forbid_overwrite:'false'}, {upload_dir:'dashscope-instant/../escape'}, {max_file_size_mb:0.001}]) {
    await withFetch(() => uploadPolicy(patch), async calls => {
      const e = env({ASR_UPLOAD_MODE:'dashscope-temporary'}), response = await worker.fetch(req(),e);
      assert.equal(response.status,502); assert.equal((await response.json()).error.code,'transcription_upload_error'); assert.equal(calls.length,1); assert.equal(e.DIARY_AUDIO.objects.size,0);
    });
  }
  await withFetch((u,o,n) => n === 1 ? uploadPolicy() : new Response('',{status:302,headers:{Location:'https://evil.example/'}}), async calls => {
    const response = await worker.fetch(req(),env({ASR_UPLOAD_MODE:'dashscope-temporary'})); assert.equal(response.status,502); assert.equal(calls.length,2); assert.equal(calls[1][1].redirect,'manual');
  });
});
test('provider-local path retains input and quota bounds before acquiring an upload policy', async () => withFetch(uploadPolicy, async calls => {
  assert.equal((await worker.fetch(req(wav(601)),env({ASR_UPLOAD_MODE:'dashscope-temporary'}))).status,413);
  const e=env({ASR_UPLOAD_MODE:'dashscope-temporary', AI_LIMITS:{fetch:async()=>new Response('',{status:429})}});
  assert.equal((await worker.fetch(req(),e)).status,429); assert.equal(calls.length,0);
}));
test('submit requests timestamped Flash, stores no access code and signs a narrowly scoped audio URL', async () => withFetch(submitted, async calls => {
  const e = env(), job = await start(e);
  const [url, options] = calls[0], body = JSON.parse(options.body);
  assert.equal(url, 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription');
  assert.equal(options.redirect, 'manual'); assert.equal(options.headers['X-DashScope-Async'], 'enable');
  assert.equal(body.model, 'qwen3-asr-flash-filetrans'); assert.deepEqual(body.parameters, {channel_id: [0], enable_words: true, enable_itn: false});
  assert.equal(body.input.file_urls, undefined); assert.ok(!options.body.includes(CODE));
  const record = e.DIARY_AUDIO.readJob(job.jobId); assert.equal(record.providerTask, TASK); assert.notEqual(record.tokenHash, job.jobToken);
  assert.ok(!JSON.stringify(record).includes(CODE));
  const audio = await worker.fetch(new Request(body.input.file_url), e);
  assert.equal(audio.status, 200); assert.equal((await audio.arrayBuffer()).byteLength, wav().byteLength);
  const head = await worker.fetch(new Request(body.input.file_url, {method: 'HEAD'}), e); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const tampered = new URL(body.input.file_url); tampered.searchParams.set('expires', String(Math.floor(Date.now() / 1000) + 7200));
  assert.equal((await worker.fetch(new Request(tampered), e)).status, 403);
  const unsigned = new URL(body.input.file_url); unsigned.searchParams.delete('signature');
  assert.equal((await worker.fetch(new Request(unsigned), e)).status, 403);
  const other = new URL(body.input.file_url); other.pathname = '/api/transcribe/audio/' + crypto.randomUUID();
  assert.equal((await worker.fetch(new Request(other), e)).status, 403);
}));
test('only the job token owner can poll; caller-supplied provider IDs are never accepted', async () => withFetch(submitted, async calls => {
  const e = env(), job = await start(e);
  assert.equal((await worker.fetch(poll(job, {headers: {'X-Transcription-Token': 'x'.repeat(72)}}), e)).status, 403);
  assert.equal((await worker.fetch(poll(job, {headers: {}}), e)).status, 403);
  assert.equal((await worker.fetch(poll({...job, jobId: '../secret'}), e)).status, 400);
  assert.equal((await worker.fetch(poll({...job, jobId: crypto.randomUUID()}), e)).status, 404);
  assert.equal(calls.length, 1);
}));
test('completed transcription normalizes milliseconds, downloads without credentials, deletes audio and caches result', async () => withFetch((url, options, n) => n === 1 ? submitted() : n === 2 ? completed() : transcript(), async calls => {
  const e = env(), job = await start(e);
  const response = await worker.fetch(poll(job), e); assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, {jobId: job.jobId, status: 'completed', text: '今天很开心。', segments: [{start: .25, end: 1.75, text: '今天很开心。'}]});
  assert.equal(calls[2][0], RESULT.replace('http:', 'https:')); assert.equal(calls[2][1].headers, undefined);
  assert.equal(e.DIARY_AUDIO.objects.has(`transcribe/audio/${job.jobId}.wav`), false);
  const again = await worker.fetch(poll(job), e); assert.deepEqual(await again.json(), result); assert.equal(calls.length, 3);
}));
test('pending polls are throttled without spending a new quota or creating a new paid task', async () => withFetch(submitted, async calls => {
  let reservations = 0; const e = env({AI_LIMITS: {fetch: async () => {reservations++; return Response.json({allowed: true});}}}), job = await start(e);
  const first = await worker.fetch(poll(job), e); assert.equal(first.status, 202);
  assert.equal((await first.json()).status, 'pending');
  assert.equal((await worker.fetch(poll(job), e)).status, 202);
  assert.equal(calls.length, 2); assert.equal(reservations, 1);
}));
test('submit provider errors clean temporary audio and hide upstream details', async () => {
  for (const variant of [() => new Response('PRIVATE API DETAIL', {status: 401}), () => Response.json({output: {task_id: '../bad', task_status: 'PENDING'}}), () => new Response('{bad')]) {
    await withFetch(variant, async () => {
      const e = env(), response = await worker.fetch(req(), e); assert.equal(response.status, 502);
      assert.ok(!(await response.text()).includes('PRIVATE')); assert.equal(e.DIARY_AUDIO.objects.size, 0);
    });
  }
});
test('failed provider job deletes audio, preserves private diagnostics and returns a safe failure', async () => withFetch((u, o, n) => n === 1 ? submitted() : Response.json({output: {task_id: TASK, task_status: 'FAILED', code: 'FILE_403_FORBIDDEN', message: 'PRIVATE DETAIL'}}), async calls => {
  const e = env(), job = await start(e), response = await worker.fetch(poll(job), e);
  assert.equal(response.status, 422); assert.equal((await response.json()).error.code, 'transcription_failed');
  assert.equal(e.DIARY_AUDIO.objects.has(`transcribe/audio/${job.jobId}.wav`), false);
  const stored = e.DIARY_AUDIO.readJob(job.jobId);
  assert.equal(stored.providerTask, TASK); assert.deepEqual(stored.failure, {reason: 'provider_terminal', code: 'FILE_403_FORBIDDEN', status: 'FAILED'});
  assert.ok(!JSON.stringify(stored).includes('PRIVATE DETAIL'));
  assert.equal((await worker.fetch(poll(job), e)).status, 422); assert.equal(calls.length, 2);
}));
test('provider result URLs cannot target arbitrary hosts, credentials, ports or redirects', async () => {
  for (const url of ['http://127.0.0.1/private', 'https://example.com', 'https://evil.oss-cn-beijing.aliyuncs.com/file', 'https://user@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/file', 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:8080/file']) {
    await withFetch((u, o, n) => n === 1 ? submitted() : completed(url), async calls => {
      const e = env(), job = await start(e); assert.equal((await worker.fetch(poll(job), e)).status, 422); assert.equal(calls.length, 2);
      assert.equal(e.DIARY_AUDIO.objects.has(`transcribe/audio/${job.jobId}.wav`), false);
    });
  }
  await withFetch((u, o, n) => n === 1 ? submitted() : n === 2 ? completed() : new Response('', {status: 302, headers: {Location: 'http://127.0.0.1/'}}), async calls => {
    const e = env(), job = await start(e); assert.equal((await worker.fetch(poll(job), e)).status, 502);
    assert.equal(calls.length, 3); assert.equal(calls[2][1].redirect, 'manual');
  });
});
test('malformed or implausible timestamps fail closed; silence may produce empty captions', async () => {
  for (const sentences of [[{begin_time: -1, end_time: 200, text: 'bad'}], [{begin_time: 0, end_time: 9999999, text: 'bad'}], [{begin_time: 500, end_time: 100, text: 'bad'}], []]) {
    await withFetch((u, o, n) => n === 1 ? submitted() : n === 2 ? completed() : Response.json({transcripts: [{channel_id: 0, text: 'bad', sentences}]}), async () => {
      const e = env(), job = await start(e); assert.equal((await worker.fetch(poll(job), e)).status, 422);
    });
  }
  await withFetch((u, o, n) => n === 1 ? submitted() : n === 2 ? completed() : Response.json({transcripts: []}), async () => {
    const e = env(), job = await start(e), response = await worker.fetch(poll(job), e); assert.equal(response.status, 200); assert.deepEqual((await response.json()).segments, []);
  });
});
test('expired jobs delete both temporary audio and stored transcript metadata', async () => withFetch(submitted, async calls => {
  const e = env(), job = await start(e), record = e.DIARY_AUDIO.readJob(job.jobId);
  record.expiresAt = Date.now() - 1; await e.DIARY_AUDIO.put(`transcribe/jobs/${job.jobId}.json`, JSON.stringify(record));
  assert.equal((await worker.fetch(poll(job), e)).status, 410); assert.equal(e.DIARY_AUDIO.objects.size, 0); assert.equal(calls.length, 1);
}));
test('follow-up receives the actual answer and question, omits access code and uses nonthinking Flash', async () => withFetch(() => Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({question: '朋友说的哪句话，让你轻松了？'})}}]}), async calls => {
  const input = {action: 'followup', accessCode: CODE, question: '今天想留下一件什么事？', text: '今天和朋友聊完，轻松了很多。'};
  const response = await worker.fetch(req(JSON.stringify(input), {path: '/api/coach', headers: {'Content-Type': 'application/json'}}), env());
  assert.equal(response.status, 200); assert.equal((await response.json()).question, '朋友说的哪句话，让你轻松了？');
  const sent = JSON.parse(calls[0][1].body); assert.equal(sent.model, 'deepseek-v4-flash'); assert.deepEqual(sent.thinking, {type: 'disabled'});
  assert.equal(sent.max_tokens, 200); assert.match(sent.messages[0].content, /one concrete detail/);
  const data = JSON.parse(sent.messages[1].content); assert.equal(data.question, input.question); assert.equal(data.diaryText, input.text); assert.ok(!calls[0][1].body.includes(CODE));
}));
test('follow-up refuses blank question or answer before provider spend', async () => withFetch(submitted, async calls => {
  for (const input of [{question: '', text: 'answer'}, {question: 'question', text: ''}, {question: 'x'.repeat(1001), text: 'answer'}]) {
    const response = await worker.fetch(req(JSON.stringify({action: 'followup', accessCode: CODE, ...input}), {path: '/api/coach', headers: {'Content-Type': 'application/json'}}), env());
    assert.equal(response.status, 400);
  }
  assert.equal(calls.length, 0);
}));
