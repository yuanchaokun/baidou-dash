# 今记 deployment

Public site: https://baidou.cam/ . Keep https://cam.baidou.work/ active: IndexedDB recordings belong to their original browser origin and are not automatically migrated.

Cloudflare Pages project: `baidou-cam`, production branch `main`, upload directory `vlog`.
Pages advanced `vlog/_worker.js` provides question generation, one contextual follow-up, and reflection feedback with DeepSeek `deepseek-v4-flash` and thinking disabled. Optional Qwen `qwen3-asr-flash-filetrans` generates timestamped transcripts. Never put API credentials in static files.

Production variables:
- Secret `DEEPSEEK_API_KEY`.
- Secret `COACH_ACCESS_CODE` (current policy).
- `DEEPSEEK_MODEL=deepseek-v4-flash`.
- Service binding `AI_LIMITS` → `baidou-cam-limits`, environment `production`.
- Defaults: 100 requests/site/day, 20/IP/day, 3/IP/minute. Override with `COACH_DAILY_LIMIT`, `COACH_IP_DAILY_LIMIT`, `COACH_IP_MINUTE_LIMIT`.
- For private automatic captions: secret `DASHSCOPE_API_KEY` (Beijing region), secret `DIARY_AUDIO_SIGNING_KEY` (random signing key), R2 binding `DIARY_AUDIO` to a dedicated private temporary bucket. Keep `COACH_ACCESS_CODE` configured; audio endpoints never allow public mode.
- Configure a one-day deletion lifecycle for the dedicated bucket. Completed/failed jobs delete audio immediately; abandoned audio and cached transcripts need the lifecycle as a final cleanup guarantee. Audio URLs and job access expire after one hour even before physical lifecycle deletion.

The limits Worker has no public routes, workers.dev URL or preview URLs. Its singleton SQLite Durable Object reserves quotas atomically; it stores only random request IDs, UTC day/minute and daily salted IP hashes. It does not store journals or videos.

Deploy:
```sh
wrangler deploy --config vlog-infra/wrangler.limits.jsonc
wrangler pages deploy vlog --project-name baidou-cam --branch main
```
Secrets and the service binding are configured in the Pages production environment, outside this repository. Do not deploy this infrastructure directory as static assets.

Verification:
```sh
node --test vlog-infra/worker.test.mjs vlog-infra/transcription.test.mjs
```
Node 22+ with node:sqlite required. Tests exercise the actual limiter code and SQLite; only the Cloudflare platform base class and DeepSeek provider response are mocked. Also verify production `/api/coach/status`, denied missing-code requests, and one authenticated request for each action. `/_worker.js` must return 404.

Browser recordings and drafts remain local. Enabled automatic captions upload only the browser-extracted mono audio to the private temporary R2 bucket, then provide a one-hour signed URL to DashScope. Recognized text and timestamps are cached privately in R2 for retryable polling; result access requires both the owner access code and an unguessable job token. Audio is removed once transcription completes/fails. The app sends recognized text, the preceding question, and optional goal to DeepSeek for follow-up generation. Provider retention follows the provider's policy; bucket deletion does not promise deletion at the provider. DeepSeek Flash itself does not transcribe audio.

See [PERSONAL_AI_API.md](./PERSONAL_AI_API.md) for request/response contracts and practical limits. Backend tests use mocked R2/provider responses and do not establish live provider latency or actual subtitle alignment.

Owner-only trial: `ASR_UPLOAD_MODE=dashscope-temporary` uses DashScope private temporary uploads (automatic expiry within 48 hours) to avoid Cloudflare signed-URL fetch failures. Audio is not duplicated in R2 in this mode; R2 keeps expiring job metadata/results. UI must accurately state the provider retention period. See `PERSONAL_AI_API.md`.
