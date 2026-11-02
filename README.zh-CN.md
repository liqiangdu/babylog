# BabyLog

[English](README.md)

BabyLog 是一个面向家庭的宝宝成长记录应用。前端使用 Vite + TypeScript，后端使用 Rust + Axum + SQLite。

默认运行模式是「前端 + 后端 + 需要登录」：业务数据保存在后端数据库中，浏览器仅保存轻量的界面偏好。

## 架构

- `src/`：前端应用（Vite 入口：`src/main.ts`）
- `backend/`：Rust API（认证、日志记录、统计、上传、AI 会话）
- `backend/data/babylog.db`：SQLite 数据库
- `backend/data/objects/`：通过 `/media/*` 提供服务的上传图片

## 快速开始（开发）

### 1）启动前端

```bash
npm install
npm run dev
```

默认地址通常为 `http://localhost:3000`。

### 2）启动后端（必需）

```bash
cd backend
cargo run
```

默认监听地址是 `127.0.0.1:8787`（仅本机）。

### 3）打开应用

在浏览器中打开 `http://localhost:3000`。

请尽量保持使用 `localhost`（不要与 `127.0.0.1` 混用），以避免 `SameSite=Lax` Cookie 在跨站点判定下带来的问题。前端默认的 API 基址在 `src/config/api-base.ts` 中为 `http://localhost:8787/api`。

## 手动启动服务

前后端在不同终端分别运行。

前端（项目根目录）：

```bash
npm install
npm run dev
```

后端（`backend/`）：

```bash
cd backend
cargo run
```

如需在局域网访问，可设置监听地址：

```bash
BABYLOG_LISTEN=0.0.0.0:8787 cargo run
```

## 生产环境前端构建

```bash
npm install
npm run build
npx --yes serve dist
```

## 核心功能

- 记录：喂养、睡眠、尿布、体温、洗澡、用药、补充剂、发育等
- 时间线：支持类型/日期过滤与分页
- 宝宝档案：昵称、生日、性别、血型
- 疫苗计划：排期管理、设置、模板编辑
- 统计：按区间聚合与图表
- 图片上传：多图上传，返回 `/media/...` URL
- AI 对话：流式接口（需要配置 `DEEPSEEK_API_KEY`）

## API 概览

后端提供的接口：

- 健康检查：`GET /health`
- 认证：`POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout`
- 账号：`PUT /api/auth/email`、`PUT /api/auth/password`、`PUT /api/auth/avatar`
- 审计：`GET /api/audit`
- 档案：`GET/PUT /api/profile`
- 记录：`GET/POST /api/entries`、`PUT/DELETE /api/entries/:id`
- 疫苗：`GET/PUT /api/vaccines`、`GET/PUT /api/vaccine-settings`、`GET/PUT /api/vaccine-templates`
- 统计：`GET /api/stats`
- 上传：`POST /api/uploads`（`multipart/form-data`，重复字段名 `file`）
- 媒体：`GET /media/<filename>`
- AI：`POST /api/chat/stream`、`GET/PUT /api/ai-project`

## 安全默认与部署说明

默认配置偏向安全，除非确有需要，不建议放宽。

- 缺省启用 Cookie 会话：`BABYLOG_COOKIE_MODE=1`
  - `babylog_session` 为 HttpOnly
  - 写请求需同时携带 `babylog_csrf` + `X-CSRF-Token`（双提交）
- CORS 缺省允许常见本地开发来源；生产请显式设置 `BABYLOG_ALLOWED_ORIGINS`
- `BABYLOG_CORS_PERMISSIVE=1` 仅用于本地临时调试
- 在反向代理后建议开启：
  - `BABYLOG_COOKIE_SECURE=1`
  - `BABYLOG_HSTS=1`
  - `BABYLOG_TRUST_PROXY=1`
- 生产强烈建议设置 `BABYLOG_PEPPER`
- `BABYLOG_PUBLIC_BASE` 控制上传媒体 URL 的对外域名

## 常用后端环境变量

- `BABYLOG_LISTEN`：监听地址（默认 `127.0.0.1:8787`）
- `BABYLOG_ALLOWED_ORIGINS`：允许的 CORS 来源（逗号分隔）
- `BABYLOG_CORS_PERMISSIVE`：设为 `1` 时放宽 CORS（仅限开发）
- `BABYLOG_COOKIE_MODE`：`1`=Cookie 模式（默认），`0`=Bearer 模式
- `BABYLOG_COOKIE_SECURE`：设为 `1` 时为 Cookie 增加 `Secure`
- `BABYLOG_HSTS`：设为 `1` 时添加 HSTS 响应头（HTTPS 场景）
- `BABYLOG_TRUST_PROXY`：设为 `1` 时信任代理 IP 头
- `BABYLOG_PEPPER`：密码 pepper
- `BABYLOG_PUBLIC_BASE`：上传媒体 URL 的对外域名
- `DEEPSEEK_API_KEY`：启用 AI 流式接口

完整的变量说明与路由细节见 `backend/README.md`。

## 数据持久化模型

- 业务数据：存储在 `backend/data/babylog.db`（按用户隔离）
- 上传文件：存储在 `backend/data/objects/`，通过 `/media/*` 提供访问
- 浏览器 localStorage：仅存 UI 偏好，不作为业务数据源

## 许可证

MIT

