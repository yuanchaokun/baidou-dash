# Personal diary AI API

All JSON responses use `Cache-Control: no-store`. Errors are `{ "error": { "code": "...", "message": "..." } }` with a non-2xx HTTP status. No provider key or raw provider error is returned.

## Availability and owner access

- `GET /api/coach/status`: `{available, requiresAccessCode, transcriptionAvailable}`. Checks binding/config presence, not live provider account balance.
- `GET /api/coach/access`, `Authorization: Bearer <owner access code>`: `{valid:true}`. Wrong code → 401. Terminal transcription failures return 422 with code `transcription_failed`; transient upstream failures remain retryable. No provider call or quota consumption.
- All requests reject cross-origin browser callers. A direct caller without Origin can authenticate using the owner code.

## One contextual follow-up

`POST /api/coach`, JSON:

```json
{"action":"followup","accessCode":"OWNER_CODE","question":"今天想留下一件什么事？","text":"今天和朋友聊完，轻松了很多。","lang":"zh"}
```

Returns `{question:"朋友说的哪句话，让你轻松了？",source:"deepseek"}`. Input text max 6,000 characters; previous question max 1,000 characters. Uses one existing coach quota reservation. Model is DeepSeek Flash with thinking disabled and max 200 output tokens. The previous question and the actual answer are sent as data; the model is instructed to ask one specific question, without pretending to have seen the video.

## Timestamped transcription

1. `POST /api/transcribe`, `Authorization: Bearer <owner code>`, `Content-Type: audio/wav`, raw WAV body. Only PCM16, mono, 16 kHz is accepted, up to 10 minutes and 20 MiB. WAV header, length, sample rate, channels and duration are verified before storing or spending quota. Uses one existing coach quota reservation.
2. Response 202: `{jobId,jobToken,status:"pending",pollAfterMs:1500}`. Retain the pair until done; do not create another paid task when a poll needs retrying.
3. `GET /api/transcribe?job=<jobId>` with the same Authorization plus `X-Transcription-Token: <jobToken>`.
4. Pending 202: `{jobId,status:"pending",pollAfterMs:1500}`. The server suppresses repeated provider polling inside that interval. Polling does not consume AI quota.
5. Completed 200: `{jobId,status:"completed",text,segments:[{start:0.25,end:1.75,text:"今天很开心。"}]}`. Times are seconds. The result is cached for repeated polls until the one-hour job expiry. Audio containing no recognized speech may return empty text and segments.

The native DashScope request uses `qwen3-asr-flash-filetrans`, `input.file_url` (singular), `parameters.enable_words:true`, `channel_id:[0]`, `enable_itn:false`, and `X-DashScope-Async: enable`. API base is `https://dashscope.aliyuncs.com/api/v1` (existing Beijing domain remains supported). Async processing latency is not promised.

The current owner-only trial sets `ASR_UPLOAD_MODE=dashscope-temporary`. In this mode the server obtains a model-scoped upload policy, uploads the WAV directly to DashScope's private OSS temporary store, then submits an `oss://` URL with `X-DashScope-OssResourceResolve: enable`. No R2 copy of the audio is created. DashScope retains this temporary file for up to 48 hours; this API cannot delete it immediately. This is the provider's development/testing upload path. Before expanding to a public service, use a production OSS storage arrangement with an explicit retention policy. R2 still holds the private, expiring task and result cache.

Without that mode, the original signed-R2 audio transport is available. In that transport, the provider reads `/api/transcribe/audio/<uuid>?expires=<unixSeconds>&signature=<hmac>` without the owner code. This URL is signed for exactly one temporary object, expires in an hour, and supports GET/HEAD. It cannot list the bucket. Completion/failure removes the audio. Transcription JSON is fetched only from validated `dashscope-result-*.oss-*.aliyuncs.com` hosts over HTTPS, without credentials or redirects; provider HTTP result URLs are upgraded to HTTPS. Provider task IDs and result URLs are never accepted from the browser.

`DIARY_AUDIO` stores `transcribe/audio/<uuid>.wav` and `transcribe/jobs/<uuid>.json`. Job records contain a hashed token, duration, expiry, provider task ID while pending or failed, a bounded failure reason for diagnosis, and normalized transcript after completion. Configure bucket lifecycle deletion after one day; do not expose a public R2 bucket/domain. This is temporary processing storage, not a recording archive.

For a smooth private flow, a per-minute quota of 6 allows an initial generated-question request plus first-answer transcription, follow-up, and final subtitle transcription. Each can still be bounded by the existing day quotas.

## Validation boundary

Automated tests exercise actual worker routes, input validation, job ownership, signed audio access, provider error masking, timestamp normalization, cleanup, quota boundaries and completion retries, using in-memory R2 and mocked providers. Existing limiter tests exercise its real SQL against SQLite. No paid provider calls are performed by these tests. Production verification must additionally create a short real speech job, poll completion and confirm audio cleanup; frontend testing must check subtitle alignment against the final silence-trimmed video.

Official API reference checked 2026-09-08: https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference
