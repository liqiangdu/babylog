# BabyLog

[英文版](README.en.md)

BabyLog 是一个面向家庭场景的婴儿成长记录应用，前端使用 Vite + TypeScript，后端使用 Rust + Axum + SQLite。

默认工作模式是 **前后端联动 + 登录后使用**：业务数据写入后端数据库，浏览器只保留少量界面偏好。

## Architecture

- `src/`：前端应用（Vite 入口 `src/main.ts`）
- `backend/`：Rust API（认证、记录、统计、上传、AI 会话等）
- `backend/data/babylog.db`：SQLite 持久化文件
- `backend/data/objects/`：上传图片对象目录（通过 `/media/*` 访问）

## Quickstart (Development)

### 1) Start frontend

```bash
npm install
npm run dev
```

默认地址通常是 `http://localhost:3000`。

### 2) Start backend (required)

```bash
cd backend
cargo run
```

默认监听 `127.0.0.1:8787`（仅本机）。

### 3) Open app

在浏览器打开 `http://localhost:3000`。

建议开发时统一使用 `localhost`（不要混用 `127.0.0.1`），以避免 `SameSite=Lax` Cookie 跨 site 问题。前端默认 API 基址见 `src/config/api-base.ts`：`http://localhost:8787/api`。

## Start Services Manually

在两个终端分别启动前后端。

前端（仓库根目录）：

```bash
npm install
npm run dev
```

后端（`backend/`）：

```bash
cd backend
cargo run
```

如需局域网调试，可显式设置监听地址：

```bash
BABYLOG_LISTEN=0.0.0.0:8787 cargo run
```

## Production Frontend Build

```bash
npm install
npm run build
npx --yes serve dist
```

## Core Features

- 记录：喂养、睡眠、尿布、体温、洗澡、用药、补剂、发育等
- 时间轴：按类型/日期筛选，分页加载
- 宝宝档案：昵称、生日、性别、血型
- 疫苗计划：项目管理、设置、模板编辑
- 统计：按时间范围汇总与图表
- 图片上传：多图上传，返回 `/media/...` URL
- AI 对话：流式接口（需配置 `DEEPSEEK_API_KEY`）

## API Snapshot

后端默认提供：

- Health: `GET /health`
- Auth: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`
- Account: `PUT /api/auth/email`, `PUT /api/auth/password`, `PUT /api/auth/avatar`
- Audit: `GET /api/audit`
- Profile: `GET/PUT /api/profile`
- Entries: `GET/POST /api/entries`, `PUT/DELETE /api/entries/:id`
- Vaccines: `GET/PUT /api/vaccines`, `GET/PUT /api/vaccine-settings`, `GET/PUT /api/vaccine-templates`
- Stats: `GET /api/stats`
- Uploads: `POST /api/uploads`（`multipart/form-data`，字段名 `file`）
- Media: `GET /media/<filename>`
- AI: `POST /api/chat/stream`, `GET/PUT /api/ai-project`

## Security Defaults and Deployment Notes

默认配置偏向安全；仅在明确场景下放宽。

- 默认启用 Cookie 会话：`BABYLOG_COOKIE_MODE=1`
  - `babylog_session` 为 HttpOnly Cookie
  - 写请求需要 `babylog_csrf` + `X-CSRF-Token` 双提交
- CORS 默认只放行常见本地开发源；生产请显式设置 `BABYLOG_ALLOWED_ORIGINS`
- `BABYLOG_CORS_PERMISSIVE=1` 仅建议临时本地调试
- 反向代理部署建议启用：
  - `BABYLOG_COOKIE_SECURE=1`
  - `BABYLOG_HSTS=1`
  - `BABYLOG_TRUST_PROXY=1`
- 强烈建议设置 `BABYLOG_PEPPER`（生产密码安全）
- `BABYLOG_PUBLIC_BASE` 决定上传 URL 返回的公网前缀

## Backend Environment Variables (Common)

- `BABYLOG_LISTEN`：监听地址（默认 `127.0.0.1:8787`）
- `BABYLOG_ALLOWED_ORIGINS`：CORS 允许源（逗号分隔）
- `BABYLOG_CORS_PERMISSIVE`：`1` 时启用宽松 CORS（仅开发）
- `BABYLOG_COOKIE_MODE`：`1` Cookie 模式（默认），`0` Bearer 模式
- `BABYLOG_COOKIE_SECURE`：`1` 时给 Cookie 加 `Secure`
- `BABYLOG_HSTS`：`1` 时加 HSTS 响应头（HTTPS 场景）
- `BABYLOG_TRUST_PROXY`：`1` 时信任代理头获取客户端 IP
- `BABYLOG_PEPPER`：密码 pepper
- `BABYLOG_PUBLIC_BASE`：上传 URL 的公共 origin
- `DEEPSEEK_API_KEY`：启用 AI 流式接口

更完整的后端变量与接口说明见 `backend/README.md`。

## Data Persistence Model

- **业务数据**：统一写入 `backend/data/babylog.db`（按用户隔离）
- **上传文件**：写入 `backend/data/objects/`，通过 `/media/*` 提供
- **浏览器 localStorage**：仅存 UI 偏好，不存业务主数据

## License

MIT
