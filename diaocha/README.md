# 白豆自我调查 · diaocha.baidou.work

只给自己填的线上问卷：13 个部分、约 150 题，覆盖基本情况、经济、身体、心理、时间、职业现状、职业选择、能力、价值观、关系、成长、未来画像和给 AI 的说明。填完生成一份 Markdown，可下载、复制给 AI，或提交到后台存档。

## 结构

- `public/` 静态页面（Workers Static Assets）
  - `questions.js` 题库，改题只动这个文件
  - `app.js` 渲染、草稿自动保存（localStorage）、Markdown 生成、提交与历史
  - `index.html` / `style.css`
- `worker.js` 后端 `/api/*`
- `wrangler.jsonc` Worker 配置，自定义域名 `diaocha.baidou.work`

## 后端

- KV 绑定 `DIAOCHA`，key `sub:<id>` 存 `{id, createdAt, meta, answers, markdown}`；`latest` 存最近一次提交的 id。
- Secret `DIAOCHA_ACCESS_CODE`：所有 `/api` 接口（除 `/api/status`）都要带 `X-Access-Code` 头或 `?code=`。
- 接口：
  - `GET /api/status`
  - `POST /api/verify`
  - `GET /api/submissions` 列表
  - `POST /api/submissions` 提交 `{answers, markdown, meta}`
  - `GET /api/submissions/:id.json` / `:id.md` / `latest.md`
  - `DELETE /api/submissions/:id`

## 部署

```sh
cd diaocha
wrangler deploy
wrangler secret put DIAOCHA_ACCESS_CODE   # 改访问码
```

本地调试：在 `diaocha/.dev.vars` 写 `DIAOCHA_ACCESS_CODE=xxx`，然后 `wrangler dev`。

## 题型

`scale`（1–10，可带 why）、`single` / `multi`（可带其他）、`text` / `long` / `number`、`ratingList`（多条目各打分）、`allocation`（百分比分配）、`rank`（点选排序）、`options`（自填最多 6 个方向 × 5 个维度打分）。
