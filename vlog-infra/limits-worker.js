import {DurableObject} from 'cloudflare:workers';

const RESERVE_SQL = `INSERT INTO coach_requests (id, day, minute, ip_hash)
SELECT ?, ?, ?, ?
WHERE (SELECT COUNT(*) FROM coach_requests WHERE day = ?) < ?
AND (SELECT COUNT(*) FROM coach_requests WHERE day = ? AND ip_hash = ?) < ?
AND (SELECT COUNT(*) FROM coach_requests WHERE minute = ? AND ip_hash = ?) < ?
RETURNING id`;

function response(value, status = 200) {
  return Response.json(value, {status, headers: {'Cache-Control': 'no-store'}});
}
function valid(data) {
  return data && typeof data === 'object' && !Array.isArray(data)
    && typeof data.ipHash === 'string' && /^[a-f0-9]{64}$/.test(data.ipHash)
    && Number.isSafeInteger(data.now) && Math.abs(Date.now() - data.now) <= 60000
    && Number.isSafeInteger(data.globalLimit) && data.globalLimit >= 1 && data.globalLimit <= 10000
    && Number.isSafeInteger(data.ipLimit) && data.ipLimit >= 1 && data.ipLimit <= 1000
    && Number.isSafeInteger(data.minuteLimit) && data.minuteLimit >= 1 && data.minuteLimit <= 60;
}

export class CoachLimits extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS coach_requests (
      id TEXT PRIMARY KEY, day TEXT NOT NULL, minute INTEGER NOT NULL, ip_hash TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS coach_requests_day_ip ON coach_requests(day, ip_hash);
    CREATE INDEX IF NOT EXISTS coach_requests_minute_ip ON coach_requests(minute, ip_hash);`);
  }

  consume(data) {
    if (!valid(data)) return {invalid: true};
    const day = new Date(data.now).toISOString().slice(0, 10);
    const minute = Math.floor(data.now / 60000);
    // One low-volume site-wide budget is the coordination atom. No await between SQL writes.
    // The conditional INSERT checks and reserves all three quotas atomically.
    const rows = this.sql.exec(RESERVE_SQL, crypto.randomUUID(), day, minute, data.ipHash,
      day, data.globalLimit, day, data.ipHash, data.ipLimit, minute, data.ipHash, data.minuteLimit).toArray();
    this.sql.exec('DELETE FROM coach_requests WHERE day < ?', new Date(data.now - 86400000).toISOString().slice(0, 10)).toArray();
    return {allowed: rows.length === 1};
  }
}

async function readInput(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) return null;
  if (Number(request.headers.get('Content-Length') || 0) > 1024 || !request.body) return null;
  const reader = request.body.getReader(); const chunks = []; let length = 0;
  const signal = AbortSignal.timeout(3000);
  const cancel = () => {void reader.cancel().catch(() => {});};
  signal.addEventListener('abort', cancel, {once: true});
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (signal.aborted) return null;
      if (done) break;
      length += value.byteLength;
      if (length > 1024) {await reader.cancel(); return null;}
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {return null;}
  finally {signal.removeEventListener('abort', cancel); reader.releaseLock();}
}

export default {
  async fetch(request, env) {
    // No public routes, workers.dev, or preview URLs: only Pages service bindings can reach this Worker.
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/consume') return response({error: 'not_found'}, 404);
    const data = await readInput(request);
    if (!valid(data)) return response({error: 'invalid_input'}, 400);
    try {
      const stub = env.COACH_LIMITS.get(env.COACH_LIMITS.idFromName('global'));
      const result = await stub.consume(data);
      if (result.invalid) return response({error: 'invalid_input'}, 400);
      return response({allowed: result.allowed === true}, result.allowed === true ? 200 : 429);
    } catch {return response({error: 'unavailable'}, 503);}
  }
};
