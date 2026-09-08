import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';

const source = await readFile(new URL('../vlog/_worker.js', import.meta.url), 'utf8');
const {default: worker} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const questionData = {action: 'questions', topic: 'daily', style: 'gentle', goal: '记录我的变化', count: 3, lang: 'zh'};
const questions = ['今天最想留下什么？', '什么让你有了不同的看法？', '你想对明天的自己说什么？'];
const feedback = {summary: '你在练习更清楚地表达。', observations: ['你提到了准备时的紧张。'], nextStep: '下一次先说一个具体例子。'};
const limitsSource = (await readFile(new URL('./limits-worker.js', import.meta.url), 'utf8')).replace(
  "import {DurableObject} from 'cloudflare:workers';", 'class DurableObject {constructor(ctx, env) {this.ctx = ctx; this.env = env;}}');
const {default: limitsWorker, CoachLimits} = await import(`data:text/javascript;base64,${Buffer.from(limitsSource).toString('base64')}`);
function db() {
  const sqlite = new DatabaseSync(':memory:');
  const sql = {exec(query, ...args) {
    if (!args.length && query.includes('CREATE TABLE')) {sqlite.exec(query); return {toArray: () => []};}
    const rows = sqlite.prepare(query).all(...args);
    return {toArray: () => rows};
  }};
  const object = new CoachLimits({storage: {sql}}, {});
  const namespace = {idFromName(name) {assert.equal(name, 'global'); return name;}, get() {return object;}};
  return {sqlite, async fetch(url, options) {return limitsWorker.fetch(new Request(url, options), {COACH_LIMITS: namespace});}};
}
function environment(overrides = {}) {return {DEEPSEEK_API_KEY: 'test-placeholder-key', COACH_PUBLIC_ENABLED: 'true', AI_LIMITS: db(), ASSETS: {fetch: async () => new Response('static asset')}, ...overrides};}
function request(data = questionData, options = {}) {
  const {origin = 'https://baidou.cam', ip = '203.0.113.1', path = '/api/coach', method = 'POST', headers = {}, urlOrigin = 'https://baidou.cam'} = options;
  return new Request(urlOrigin + path, {method, headers: {'Content-Type': 'application/json', ...(origin ? {Origin: origin} : {}), 'CF-Connecting-IP': ip, ...headers},
    ...(method === 'GET' ? {} : {body: typeof data === 'string' ? data : JSON.stringify(data)})});
}
function provider(value = {questions}, options = {}) {
  return new Response(JSON.stringify({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(value)}}]}), options);
}
async function withProvider(fn, replacement = async () => provider()) {
  const original = globalThis.fetch; let calls = 0; let sent;
  globalThis.fetch = async (...args) => {calls++; sent = args; return replacement(...args);};
  try {await fn(() => ({calls, sent}));} finally {globalThis.fetch = original;}
}
test('assets delegate; worker source is never returned', async () => {
  const env = environment();
  assert.equal(await (await worker.fetch(request(null, {path: '/app/', method: 'GET'}), env)).text(), 'static asset');
  for (const path of ['/_worker.js', '/_worker.js.map', '/%5fworker.js']) assert.equal((await worker.fetch(request(null, {path, method: 'GET'}), env)).status, 404);
});
test('status accurately fails closed without key, policy or service binding', async () => {
  for (const patch of [{DEEPSEEK_API_KEY: undefined}, {COACH_PUBLIC_ENABLED: undefined}, {AI_LIMITS: undefined}, {AI_LIMITS: {prepare() {throw Error('secret internal detail');}}}]) {
    const response = await worker.fetch(request(null, {path: '/api/coach/status', method: 'GET'}), environment(patch));
    assert.equal(response.status, 200); assert.equal((await response.json()).available, false);
  }
  const response = await worker.fetch(request(null, {path: '/api/coach/status', method: 'GET'}), environment({COACH_ACCESS_CODE: 'access-placeholder'}));
  assert.deepEqual(await response.json(), {available: true, requiresAccessCode: true});
});
test('no key or public opt-in never calls provider', async () => withProvider(async get => {
  for (const patch of [{DEEPSEEK_API_KEY: undefined}, {COACH_PUBLIC_ENABLED: undefined}, {AI_LIMITS: undefined}]) assert.equal((await worker.fetch(request(), environment(patch))).status, 503);
  assert.equal(get().calls, 0);
}));
test('origin enforcement blocks third parties, different first-party origin and no-origin public calls', async () => withProvider(async get => {
  for (const origin of ['https://evil.example', 'https://cam.baidou.work', 'null', null]) assert.equal((await worker.fetch(request(questionData, {origin}), environment())).status, 403);
  assert.equal(get().calls, 0);
}));
test('localhost requires explicit development flag', async () => withProvider(async get => {
  const options = {origin: 'http://127.0.0.1:8790', urlOrigin: 'http://127.0.0.1:8790'};
  assert.equal((await worker.fetch(request(questionData, options), environment())).status, 403);
  assert.equal((await worker.fetch(request(questionData, options), environment({COACH_ALLOW_LOCALHOST: 'true'}))).status, 200);
  assert.equal(get().calls, 1);
}));
test('access code is required even when public enabled; valid code permits no-origin caller', async () => withProvider(async get => {
  const env = environment({COACH_ACCESS_CODE: 'a-long-placeholder-code'});
  for (const accessCode of ['', 'wrong', 'a-long-placeholder-codE']) assert.equal((await worker.fetch(request({...questionData, accessCode}), env)).status, 401);
  assert.equal(get().calls, 0);
  const response = await worker.fetch(request({...questionData, accessCode: env.COACH_ACCESS_CODE}, {origin: null}), env);
  assert.equal(response.status, 200);
  assert.ok(!get().sent[1].body.includes(env.COACH_ACCESS_CODE));
}));
test('input validation: type, JSON, lengths and enum values', async () => withProvider(async get => {
  const cases = [null, [], {}, {...questionData, count: 4}, {...questionData, topic: 'stocks'}, {...questionData, style: 'hype'}, {...questionData, lang: 'fr'}, {...questionData, goal: 'x'.repeat(1001)}, {...questionData, text: 'x'.repeat(6001)}, {...questionData, action: 'feedback'}, {...questionData, accessCode: 123}, '{bad json'];
  for (const data of cases) assert.equal((await worker.fetch(request(data), environment())).status, 400);
  assert.equal((await worker.fetch(request(questionData, {headers: {'Content-Type': 'text/plain'}}), environment())).status, 415);
  assert.equal((await worker.fetch(request('x'.repeat(25000)), environment())).status, 413);
  assert.equal(get().calls, 0);
}));
test('success uses fixed endpoint, bounded JSON output and no thinking mode', async () => withProvider(async get => {
  const response = await worker.fetch(request(), environment());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), {questions, source: 'deepseek'});
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.has('Access-Control-Allow-Origin'), false);
  const [url, options] = get().sent; const body = JSON.parse(options.body);
  assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(options.redirect, 'error');
  assert.equal(body.model, 'deepseek-v4-flash'); assert.deepEqual(body.thinking, {type: 'disabled'});
  assert.deepEqual(body.response_format, {type: 'json_object'}); assert.equal(body.max_tokens, 700);
  assert.equal(get().calls, 1);
}));
test('feedback remains text-only and excludes access code from provider data', async () => withProvider(async get => {
  const response = await worker.fetch(request({...questionData, action: 'feedback', text: '今天分享前很紧张，但我说清楚了。', topic: 'investing'}), environment());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), {feedback, source: 'deepseek'});
  const body = JSON.parse(get().sent[1].body);
  assert.match(body.messages[0].content, /never recommend securities/); assert.match(body.messages[0].content, /claim to have seen video/);
  assert.equal(body.max_tokens, 1000);
}, async () => provider({feedback})));
test('per-minute quota returns 429; accounting stores no raw IP or personal content', async () => withProvider(async get => {
  const env = environment();
  for (let i = 0; i < 3; i++) assert.equal((await worker.fetch(request(), env)).status, 200);
  const denied = await worker.fetch(request(), env); assert.equal(denied.status, 429); assert.equal(denied.headers.get('Retry-After'), '60');
  assert.equal(get().calls, 3);
  const rows = env.AI_LIMITS.sqlite.prepare('SELECT * FROM coach_requests').all();
  assert.equal(rows.length, 3); assert.equal(rows[0].ip_hash.length, 64);
  assert.ok(!JSON.stringify(rows).includes('203.0.113.1')); assert.ok(!JSON.stringify(rows).includes(questionData.goal));
}));
test('daily site and IP limits are enforced by real SQLite SQL', async () => withProvider(async get => {
  const site = environment({COACH_DAILY_LIMIT: '2'});
  for (let i = 0; i < 2; i++) assert.equal((await worker.fetch(request(questionData, {ip: '203.0.113.' + i}), site)).status, 200);
  assert.equal((await worker.fetch(request(questionData, {ip: '203.0.113.99'}), site)).status, 429);
  const ip = environment({COACH_IP_DAILY_LIMIT: '1'});
  assert.equal((await worker.fetch(request(), ip)).status, 200);
  assert.equal((await worker.fetch(request(), ip)).status, 429);
  assert.equal(get().calls, 3);
}));
test('concurrent reservation does not exceed total quota', async () => withProvider(async get => {
  const env = environment({COACH_DAILY_LIMIT: '2'});
  const responses = await Promise.all(Array.from({length: 8}, (_, i) => worker.fetch(request(questionData, {ip: '203.0.113.' + i}), env)));
  assert.equal(responses.filter(x => x.status === 200).length, 2); assert.equal(responses.filter(x => x.status === 429).length, 6); assert.equal(get().calls, 2);
}));
test('database failure and invalid limits fail closed', async () => withProvider(async get => {
  const bad = {fetch() {throw Error('private database details');}};
  assert.equal((await worker.fetch(request(), environment({AI_LIMITS: bad}))).status, 503);
  assert.equal((await worker.fetch(request(), environment({COACH_DAILY_LIMIT: 'unlimited'}))).status, 503);
  assert.equal(get().calls, 0);
}));
test('provider failure, malformed JSON, oversized output and invalid schema stay private', async () => {
  const variants = [() => new Response('UPSTREAM PRIVATE DETAILS', {status: 401}), () => new Response('not JSON'), () => new Response('x'.repeat(33000)), () => provider({questions: ['only one']}), () => provider({questions: ['same', 'same', 'same']}), () => new Response(JSON.stringify({choices: [{finish_reason: 'length', message: {content: '{}'}}]}))];
  for (const variant of variants) await withProvider(async get => {
    const response = await worker.fetch(request(), environment()); assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'provider_error'); assert.equal(get().calls, 1);
  }, async () => variant());
});
test('provider timeout yields 504 without retry', async () => withProvider(async get => {
  const response = await worker.fetch(request(), environment()); assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'timeout'); assert.equal(get().calls, 1);
}, async () => {throw new DOMException('internal endpoint detail', 'AbortError');}));
test('the 25-second deadline aborts a hanging provider fetch', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let began = false;
  await withProvider(async get => {
    const pending = worker.fetch(request(), environment());
    while (!began) await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(25000);
    const response = await pending; assert.equal(response.status, 504); assert.equal(get().calls, 1);
  }, async (_, options) => new Promise((resolve, reject) => {
    began = true; options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true});
  }));
});
test('the same deadline cancels a stalled provider response stream', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let began = false; let cancelled = false;
  await withProvider(async () => {
    const pending = worker.fetch(request(), environment());
    while (!began) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(25000);
    const response = await pending; assert.equal(response.status, 504); assert.equal(cancelled, true);
  }, async () => {
    began = true;
    return new Response(new ReadableStream({pull() {}, cancel() {cancelled = true;}}));
  });
});
test('wrong method and unknown API route return bounded errors', async () => {
  assert.equal((await worker.fetch(request(null, {method: 'GET'}), environment())).status, 405);
  assert.equal((await worker.fetch(request(null, {method: 'GET', path: '/api/unknown'}), environment())).status, 404);
});
test('private limiter rejects unsupported routes, malformed input and stale timestamps', async () => {
  const good = {ipHash: 'a'.repeat(64), now: Date.now(), globalLimit: 100, ipLimit: 20, minuteLimit: 3};
  const inaccessible = {COACH_LIMITS: {idFromName() {throw Error('must not reach storage');}}};
  assert.equal((await limitsWorker.fetch(new Request('https://limits.internal/consume'), inaccessible)).status, 404);
  for (const value of [null, {...good, ipHash: '203.0.113.1'}, {...good, now: Date.now() - 120000}, {...good, globalLimit: 0}, {...good, minuteLimit: 1000}]) {
    const request = new Request('https://limits.internal/consume', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)});
    assert.equal((await limitsWorker.fetch(request, inaccessible)).status, 400);
  }
  const huge = new Request('https://limits.internal/consume', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: 'x'.repeat(2048)});
  assert.equal((await limitsWorker.fetch(huge, inaccessible)).status, 400);
});
test('private limiter masks storage errors', async () => {
  const value = {ipHash: 'a'.repeat(64), now: Date.now(), globalLimit: 100, ipLimit: 20, minuteLimit: 3};
  const request = new Request('https://limits.internal/consume', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)});
  const response = await limitsWorker.fetch(request, {COACH_LIMITS: {idFromName() {throw Error('PRIVATE STORAGE DETAIL');}}});
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), {error: 'unavailable'});
});
test('Pages refuses malformed or failing limit service responses without provider spend', async () => withProvider(async get => {
  for (const makeResponse of [() => new Response('bad JSON'), () => Response.json({allowed: false}), () => new Response('PRIVATE LIMITER ERROR', {status: 500})]) {
    const env = environment({AI_LIMITS: {fetch: async () => makeResponse()}});
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'unavailable');
  }
  assert.equal(get().calls, 0);
}));
test('limiter deployment disables public routes and uses SQLite migrations', async () => {
  const config = JSON.parse(await readFile(new URL('./wrangler.limits.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false); assert.equal(config.routes, undefined);
  assert.deepEqual(config.migrations, [{tag: 'v1', new_sqlite_classes: ['CoachLimits']}]);
});

test('6000 Chinese characters fit the request byte limit', async () => withProvider(async () => {
  const response = await worker.fetch(request({...questionData, action: 'feedback', text: '记'.repeat(6000), goal: '想'.repeat(1000)}), environment());
  assert.equal(response.status, 200);
}, async () => provider({feedback})));
