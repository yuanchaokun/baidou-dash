# 自我调查 · zwdc.baidou.work

`diaocha/` 的独立副本，给朋友用。同一套题库与前端，但：

- 独立 Worker `baidou-zwdc`、独立 KV（`ZWDC`，绑定名仍为 `DIAOCHA`）、独立访问码 secret `DIAOCHA_ACCESS_CODE`，与 diaocha 的数据完全不通。
- 去掉了 `/finance/` 页面和 `/api/finance` 接口。
- 页面与导出文件名不带个人标识（标题「自我调查」，下载名 `zwdc-*.md`，localStorage 前缀 `zwdc:`）。

## 部署

```sh
cd zwdc
wrangler deploy
wrangler secret put DIAOCHA_ACCESS_CODE   # 换访问码
```

改题只动 `public/questions.js`；若要与 `diaocha/` 同步，复制 `app.js` / `style.css` / `questions.js` 后重新做一遍上面的去标识替换。
