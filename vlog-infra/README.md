# 今记 deployment

Public site: https://baidou.cam/ . Keep https://cam.baidou.work/ active: IndexedDB recordings belong to their original browser origin and are not automatically migrated.

Cloudflare Pages project: `baidou-cam`, production branch `main`, upload directory `vlog`.
Pages advanced `vlog/_worker.js` provides text-only question generation and reflection feedback with DeepSeek `deepseek-v4-flash` and thinking disabled. Never put API credentials in static files.

Production variables:
- Secret `DEEPSEEK_API_KEY`.
- Secret `COACH_ACCESS_CODE` (current policy).
- `DEEPSEEK_MODEL=deepseek-v4-flash`.
- Service binding `AI_LIMITS` → `baidou-cam-limits`, environment `production`.
- Defaults: 100 requests/site/day, 20/IP/day, 3/IP/minute. Override with `COACH_DAILY_LIMIT`, `COACH_IP_DAILY_LIMIT`, `COACH_IP_MINUTE_LIMIT`.

The limits Worker has no public routes, workers.dev URL or preview URLs. Its singleton SQLite Durable Object reserves quotas atomically; it stores only random request IDs, UTC day/minute and daily salted IP hashes. It does not store journals or videos.

Deploy:
```sh
wrangler deploy --config vlog-infra/wrangler.limits.jsonc
wrangler pages deploy vlog --project-name baidou-cam --branch main
```
Secrets and the service binding are configured in the Pages production environment, outside this repository. Do not deploy this infrastructure directory as static assets.

Verification:
```sh
node --test vlog-infra/worker.test.mjs
```
Node 22+ with node:sqlite required. Tests exercise the actual limiter code and SQLite; only the Cloudflare platform base class and DeepSeek provider response are mocked. Also verify production `/api/coach/status`, denied missing-code requests, and one authenticated request for each action. `/_worker.js` must return 404.

Browser recording, questions and drafts are local. AI sends only explicitly submitted goals/text. Optional browser speech recognition or separately configured transcription services have their own audio handling. DeepSeek Flash does not transcribe video/audio in this integration.

