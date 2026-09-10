// diaocha.baidou.work · 白豆自我调查 后端
// 静态页面由 Workers Static Assets 提供；/api/* 由这里处理。
// 存储：KV 绑定 DIAOCHA，key 形如 sub:<id>，value 为 JSON {id, createdAt, meta, answers, markdown}。
// 鉴权：所有 /api 接口（除 status）都需要访问码，通过 X-Access-Code 头或 ?code= 传入，与 secret DIAOCHA_ACCESS_CODE 比较。

const MAX_BODY = 1024 * 1024; // 1 MB
const ID_RE = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{6}$/;

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}
function fail(status, code, message) { return json({ error: code, message }, status); }

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) {
    // 长度不同直接判否，但仍做一次比较避免时间差异过大
    let x = 0; for (let i = 0; i < ab.byteLength; i++) x |= ab[i] ^ (bb[i % (bb.byteLength || 1)] || 0);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function authorized(request, env) {
  const expected = (env.DIAOCHA_ACCESS_CODE || '').trim();
  if (!expected) return false;
  const url = new URL(request.url);
  const given = (request.headers.get('X-Access-Code') || url.searchParams.get('code') || '').trim();
  if (!given) return false;
  return timingSafeEqual(given, expected);
}

function newId() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const rand = Array.from(bytes, b => b.toString(36)).join('').slice(0, 6).padEnd(6, '0');
  return `${stamp}-${rand}`;
}

async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw fail(413, 'too_large', '内容太大。');
  const text = await request.text();
  if (text.length > MAX_BODY) throw fail(413, 'too_large', '内容太大。');
  try { return JSON.parse(text || '{}'); } catch { throw fail(400, 'invalid_json', '需要 JSON。'); }
}

async function handleApi(request, env, path) {
  const method = request.method;

  if (path === '/api/status' && method === 'GET') {
    return json({ configured: !!(env.DIAOCHA_ACCESS_CODE && env.DIAOCHA), version: '1' });
  }
  if (!env.DIAOCHA) return fail(503, 'not_configured', '后台还没有配置 KV 存储。');
  if (!authorized(request, env)) return fail(401, 'unauthorized', '访问码不正确。');

  if (path === '/api/verify' && method === 'POST') return json({ ok: true });

  // 云端草稿：只有一份，边填边覆盖，防止手机端浏览器清掉本地存储
  if (path === '/api/draft') {
    if (method === 'GET') {
      const raw = await env.DIAOCHA.get('draft');
      return new Response(raw || 'null', { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (method === 'PUT') {
      const body = await readJson(request);
      if (!body || typeof body.answers !== 'object') return fail(400, 'invalid_body', '需要 answers。');
      const updatedAt = Number(body.updatedAt) || Date.now();
      const draft = { answers: body.answers, updatedAt, savedAt: new Date().toISOString(), device: String(body.device || '').slice(0, 80) };
      await env.DIAOCHA.put('draft', JSON.stringify(draft));
      return json({ ok: true, updatedAt });
    }
    if (method === 'DELETE') { await env.DIAOCHA.delete('draft'); return json({ ok: true }); }
    return fail(405, 'method_not_allowed', '不支持的方法。');
  }

  if (path === '/api/submissions' && method === 'GET') {
    const items = [];
    let cursor;
    do {
      const page = await env.DIAOCHA.list({ prefix: 'sub:', cursor, limit: 1000 });
      for (const k of page.keys) {
        const m = k.metadata || {};
        items.push({ id: k.name.slice(4), createdAt: m.createdAt || null, answered: m.answered ?? null, total: m.total ?? null });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    items.sort((a, b) => (b.id > a.id ? 1 : -1));
    return json({ items });
  }

  if (path === '/api/submissions' && method === 'POST') {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || typeof body.answers !== 'object' || typeof body.markdown !== 'string') {
      return fail(400, 'invalid_body', '需要 answers 和 markdown。');
    }
    const id = newId();
    const createdAt = new Date().toISOString();
    const meta = {
      version: String(body.meta?.version || ''),
      answered: Number(body.meta?.answered) || 0,
      total: Number(body.meta?.total) || 0,
      userAgent: String(body.meta?.userAgent || '').slice(0, 120),
    };
    const record = { id, createdAt, meta, answers: body.answers, markdown: body.markdown };
    await env.DIAOCHA.put(`sub:${id}`, JSON.stringify(record), {
      metadata: { createdAt, answered: meta.answered, total: meta.total },
    });
    await env.DIAOCHA.put('latest', id);
    return json({ ok: true, id, createdAt }, 201);
  }

  const m = path.match(/^\/api\/submissions\/([^/]+?)(\.md|\.json)?$/);
  if (m) {
    const id = m[1] === 'latest' ? await env.DIAOCHA.get('latest') : m[1];
    if (!id || !ID_RE.test(id)) return fail(404, 'not_found', '没有这条记录。');
    if (method === 'DELETE') {
      await env.DIAOCHA.delete(`sub:${id}`);
      const latest = await env.DIAOCHA.get('latest');
      if (latest === id) await env.DIAOCHA.delete('latest');
      return json({ ok: true });
    }
    if (method !== 'GET') return fail(405, 'method_not_allowed', '不支持的方法。');
    const raw = await env.DIAOCHA.get(`sub:${id}`);
    if (!raw) return fail(404, 'not_found', '没有这条记录。');
    if (m[2] === '.md') {
      const rec = JSON.parse(raw);
      return new Response(rec.markdown, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="baidou-diaocha-${id}.md"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    return new Response(raw, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }

  return fail(404, 'not_found', '没有这个接口。');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url.pathname);
      } catch (e) {
        if (e instanceof Response) return e;
        console.error(e);
        return fail(500, 'internal', '服务器出错了。');
      }
    }
    if (url.pathname === '/worker.js') return new Response('Not found', { status: 404 });
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(res.body, { status: res.status, headers });
  },
};
