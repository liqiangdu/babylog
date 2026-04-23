# babylog-api

`babylog-api` 是 BabyLog 的 Rust 后端，负责认证、业务数据读写、统计、图片上传与 AI 流式接口。

技术栈：Rust + Axum + Tokio + SQLite。

## Run

```bash
cargo run
```

默认监听 `127.0.0.1:8787`。

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

## Data and Storage

- SQLite 文件：`data/babylog.db`
- 图片对象目录：`data/objects/`
- 媒体访问路径：`GET /media/<filename>`

上传接口返回 URL 由 `BABYLOG_PUBLIC_BASE` 决定（默认 `http://127.0.0.1:8787`）。

## Routes

### Health

- `GET /health`

### Auth and Account

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `PUT /api/auth/avatar`
- `PUT /api/auth/email`
- `PUT /api/auth/password`
- `GET /api/audit`

### Business APIs

- `GET /api/profile`
- `PUT /api/profile`
- `GET /api/entries`
- `POST /api/entries`
- `PUT /api/entries/:id`
- `DELETE /api/entries/:id`
- `GET /api/vaccines`
- `PUT /api/vaccines`
- `GET /api/vaccine-settings`
- `PUT /api/vaccine-settings`
- `GET /api/vaccine-templates`
- `PUT /api/vaccine-templates`
- `GET /api/stats`

### Uploads and Media

- `POST /api/uploads`
  - `multipart/form-data`
  - 字段名重复使用 `file`
  - 单文件上限：8MB（图片类型按文件头校验）
  - 路由层 body limit：48MB
  - 响应：`{ "urls": ["<public>/media/<uuid>.<ext>", ...] }`
- `GET /media/<filename>`

### AI

- `POST /api/chat/stream`（SSE）
- `GET /api/ai-project`
- `PUT /api/ai-project`（请求体上限 8MB）

## Environment Variables

### Network / CORS

- `BABYLOG_LISTEN`：监听地址，默认 `127.0.0.1:8787`
- `BABYLOG_ALLOWED_ORIGINS`：CORS 允许源（逗号分隔）
- `BABYLOG_CORS_PERMISSIVE=1`：宽松 CORS（开发排障用，不建议生产）
- `BABYLOG_PUBLIC_BASE`：上传 URL 对外前缀

### Session / Security

- `BABYLOG_COOKIE_MODE`：`1`=Cookie 会话（默认），`0`=Bearer
- `BABYLOG_COOKIE_SECURE=1`：Cookie 增加 `Secure`（HTTPS）
- `BABYLOG_HSTS=1`：增加 HSTS 响应头（HTTPS 场景）
- `BABYLOG_TRUST_PROXY=1`：信任 `X-Forwarded-For` / `X-Real-IP`
- `BABYLOG_PEPPER`：密码 pepper（生产强烈建议配置）

### AI and Rate Limit

- `DEEPSEEK_API_KEY`：启用 AI 接口
- `DEEPSEEK_BASE_URL`：DeepSeek API 基址（默认 `https://api.deepseek.com`）
- `DEEPSEEK_MODEL`：模型名（默认 `deepseek-chat`）
- `BABYLOG_CHAT_RL_WINDOW_SEC`：聊天限流窗口秒数（默认 60）
- `BABYLOG_CHAT_RL_MAX`：窗口内最大请求数（默认 30）

## Security Defaults

- 默认启用防御性响应头：`nosniff`、`Referrer-Policy`、`Permissions-Policy`、`X-Frame-Options`
- 写请求在 Cookie 模式下执行 CSRF 校验（Cookie + 请求头双提交）
- 默认 CORS 仅允许常见本地开发源并允许凭证
- 密码哈希链路包含 Argon2；配置 `BABYLOG_PEPPER` 后会增加 HMAC 预处理层

## Reverse Proxy Notes

生产建议把前端与后端挂在同一站点（同域），再开启：

- `BABYLOG_COOKIE_MODE=1`
- `BABYLOG_COOKIE_SECURE=1`
- `BABYLOG_HSTS=1`
- `BABYLOG_TRUST_PROXY=1`
- `BABYLOG_ALLOWED_ORIGINS=<your-frontend-origin>`
- `BABYLOG_PUBLIC_BASE=<your-public-origin>`

这样可以获得更稳定的 Cookie 会话行为与更清晰的安全边界。
