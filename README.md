# BabyLog

一个面向新手父母的婴儿成长记录 Web 应用，支持喂养、睡眠、尿布、生长、疫苗计划与统计分析。

## 功能亮点

- 日常记录：喝奶、睡觉、换尿布、体温、洗澡、用药、补剂、发育等
- 时间轴：按类型/按天筛选，默认分页加载（每次 20 条）
- 宝宝信息：昵称、生日、性别、血型
- 数据统计：支持自定义时间范围
- 图表模式：支持数值指标趋势查看、Y 轴单位与刻度、hover 提示
- 疫苗计划：地区模板、提醒设置、浏览器通知
- 模板编辑：支持表格化自定义疫苗模板编辑
- 数据导入导出：JSON 备份与恢复
- 每条记录可选附加多张照片（走 API 时上传到服务端对象目录 `data/objects/`，通过 `/media/...` 提供直链，SQLite 仅存 URL；纯本地模式需启动后端才能上传）

## 技术栈

- 前端：HTML + CSS + **TypeScript**（Vite 开发与打包；入口 `src/main.ts`）
- 浏览器 `localStorage` 持久化
- 可选 Rust 后端（Axum + Tokio）用于高性能 API

## 快速开始

### 方式 1：Vite 开发服务器（推荐）

```bash
npm install
npm run dev
```

浏览器打开终端提示的本地地址（默认 `http://localhost:3000`）。业务代码在 `src/`，由 Vite 编译 `index.html` 中的 `<script type="module" src="/src/main.ts">`。

### 方式 2：生产静态资源

```bash
npm install
npm run build
npx --yes serve dist
```

### 方式 3：运行 Rust API（可选）

> 目录：`backend/`

```bash
cd backend
cargo run
```

默认监听地址由环境变量 **`BABYLOG_LISTEN`** 决定，格式为 `host:port`，未设置时为 **`127.0.0.1:8787`**（仅本机可连）。同一局域网内用手机或其它设备访问时，请改为例如 **`0.0.0.0:8787`**，并同步配置前端的 `VITE_API_BASE` 与 **`BABYLOG_ALLOWED_ORIGINS`**（见下文 CORS 说明）。`./start.sh` 默认会导出 `BABYLOG_LISTEN=127.0.0.1:$BACKEND_PORT`，可在命令前覆盖：`BABYLOG_LISTEN=0.0.0.0:8787 ./start.sh`。

开发机用 Vite 暴露到局域网时，可执行：`npm run dev -- --host 0.0.0.0 --port 3000`，再把 `BABYLOG_ALLOWED_ORIGINS` 中加入 `http://<本机局域网IP>:3000`。

默认提供：

- `GET /health`
- `POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout`
- `PUT /api/auth/email`、`PUT /api/auth/password`、`PUT /api/auth/avatar`
- `GET /api/audit`（返回当前用户最近 100 条审计记录）
- `GET/PUT /api/profile`
- `GET/POST /api/entries`
- `DELETE /api/entries/:id`
- `POST /api/uploads`（multipart，字段名 `file`，返回 `{ "urls": ["…/media/<uuid>.jpg"] }`）
- `GET /media/<file>`（静态图片，高性能直出）
- `GET /api/stats`

登录态说明：

- 账号密码使用 Argon2 哈希，session token 保存在 `sessions` 表（默认 30 天有效）。
- 登录支持「用户名或邮箱」。
- **默认启用 HttpOnly Cookie 会话**（`BABYLOG_COOKIE_MODE=1`）：登录成功后后端把 session token 写入 `Set-Cookie: babylog_session=...; HttpOnly; SameSite=Lax`，前端完全不接触 token，也不写 `localStorage`，抗 XSS 窃取。写请求通过 `babylog_csrf` Cookie + `X-CSRF-Token` 头双提交防 CSRF。设置 `BABYLOG_COOKIE_MODE=0` 可退回纯 Bearer 模式（仅推荐跨域 API 场景）。
- 本地开发前端（`npm run dev` / Vite，默认 `http://localhost:3000`）访问 API 时使用 `http://localhost:8787/api`，和前端同 site（`localhost`），`SameSite=Lax` Cookie 可以正常带上。如果换成 `127.0.0.1` 访问前端，请同时把 API 地址也改成 `127.0.0.1:8787`，保持同 site。
- 所有业务接口（profile / entries / vaccines / stats / uploads / chat）都按登录态授权，数据按 `user_id` 隔离，不同账号彼此不可见。
- 历史遗留的 pre-auth 数据（multi-user 迁移时临时落户到虚拟 `__legacy__` 账号的记录，以及老版本的单行表 `profile` / `vaccine_settings` / `vaccine_templates`）不再保留：启动时会自动 DELETE / DROP 掉，并把只被其引用的照片对象文件一并清掉。日志会打印本次清理的行数（若无则静默）。
- 后端不可达时前端可切换「仅在本机使用」，走 `localStorage` 回退（仅此场景使用本地缓存）。

安全加固相关环境变量（可选）：

- **`BABYLOG_LISTEN`**：HTTP 监听地址，默认 `127.0.0.1:8787`。局域网或真机调试请设为 **`0.0.0.0:8787`**（或指定网卡 IP），并配置 `BABYLOG_ALLOWED_ORIGINS` 与前端 `VITE_API_BASE`。
- `BABYLOG_PEPPER`：密码 pepper。会通过 HMAC-SHA256 对密码做一层预杂凑再交给 Argon2；**强烈建议**在生产环境设置为一段高熵随机串。空值时会退化到纯 Argon2，启动时会打印告警。旧 hash 会在下次登录时自动兼容（不需要重置密码）。
- `BABYLOG_COOKIE_MODE`：会话模式，默认 `1`（Cookie 模式）。`/api/auth/login` 和 `/api/auth/register` 成功后同时返回 JSON 中的 `token` / `csrf_token`（老客户端兼容），并 `Set-Cookie: babylog_session=...; HttpOnly; SameSite=Lax` + 非 HttpOnly 的 `babylog_csrf`；前端从 Cookie 读取 CSRF 并自动附加 `X-CSRF-Token`。设为 `0` 退回 Bearer 模式。
- `BABYLOG_COOKIE_SECURE=1`：给 Cookie 加 `Secure` 属性（配合 HTTPS 使用）。
- `BABYLOG_HSTS=1`：启用 HSTS 响应头（仅在 HTTPS 前端下设置）。
- `BABYLOG_ALLOWED_ORIGINS`：逗号分隔的 CORS 允许源，例如 `https://app.example.com`；未设置时默认允许 `localhost`/`127.0.0.1` 的常见端口。凭证 Cookie 模式下 CORS 必须配置成具体的源（浏览器禁止 `*` + credentials）。
- `BABYLOG_CORS_PERMISSIVE=1`：打开 `*` 宽松 CORS（仅供临时本地调试，不能和 Cookie 模式并用）。
- `BABYLOG_TRUST_PROXY=1`：在反向代理后部署时启用，从 `X-Forwarded-For` / `X-Real-IP` 获取客户端 IP 供限流 / 审计 / 异地登录检测使用；未启用时头部会被忽略以防伪造。
- `BABYLOG_PUBLIC_BASE`：对外可访问的 origin（影响上传返回的 `/media/...` URL），默认 `http://127.0.0.1:8787`。

其他加固：

- 密码使用 HMAC-SHA256(pepper, pwd) 预杂凑 + Argon2 存储，避免裸库泄露即离线爆破。
- 注册时服务端做 zxcvbn 强度检查（score ≥ 3），过弱返回 400 并带反馈。
- 登录/注册走内存滑动窗口限流：10 分钟 20 次（触及后返回 `429` 并带 `Retry-After`），累计 10 次失败直接锁 15 分钟；登录按 IP 与用户名双桶。
- 注册冲突（用户名已存在）统一返回 `400 registration failed`，避免用户名枚举；登录失败统一 `401 invalid credentials`。
- 异地登录检测：session 表记录 `last_ip` / `last_ua`，登录时若对当前用户从未见过此 IP 或 UA，响应里附带 `new_device: true`，前端会弹提醒。
- 审计日志：`audit_log` 表记录 register / login / login_failed / logout / upload / entry_delete / profile_update，带 IP 和 User-Agent；用户可通过 `GET /api/audit` 查询自己的最近 100 条。
- 所有 `/api` 响应自动带上 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Permissions-Policy: geolocation=(), microphone=(), camera=()`、`X-Frame-Options: DENY`；设置 `BABYLOG_HSTS=1` 时再加 HSTS。
- Cookie 模式下所有写请求 (`POST` / `PUT` / `DELETE`) 都要求 `X-CSRF-Token` 与 `babylog_csrf` Cookie 常量时间比对；Bearer 模式不触发 CSRF 检查（浏览器无法自动注入 Authorization）。
- JSON 接口默认 1 MB body 上限，`/api/uploads` 仍是 48 MB。
- 过期 session 由后台任务每小时清理；上传文件名是服务端生成的 UUID 并按文件头探测扩展名，不接受客户端文件名。
- 上传日志会记录 `user_id`（审计用）。

### 反向代理模板（Caddy）

推荐生产部署用 Caddy 做 HTTPS 终止 + 同域 Cookie 会话：

```caddy
app.example.com {
  encode zstd gzip
  # 前端静态资源
  root * /var/www/babylog
  file_server

  # 后端 API 走同域前缀，Cookie 自然带过去
  @api path /api/* /media/* /health
  handle @api {
    reverse_proxy 127.0.0.1:8787 {
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
    }
  }
}
```

同时后端启动环境：

```bash
BABYLOG_PEPPER="$(head -c 48 /dev/urandom | base64)" \
BABYLOG_COOKIE_MODE=1 \
BABYLOG_COOKIE_SECURE=1 \
BABYLOG_HSTS=1 \
BABYLOG_TRUST_PROXY=1 \
BABYLOG_ALLOWED_ORIGINS=https://app.example.com \
BABYLOG_PUBLIC_BASE=https://app.example.com \
cargo run --release
```

### 一键启动（前端 + Rust API）

**Windows（PowerShell）**：

```powershell
.\start.ps1
```

会自动打开两个 PowerShell 窗口：

- 前端 Vite 开发服务（`npm run dev`）
- Rust API（使用默认 MSVC 工具链执行 `cargo run`，需已安装 Visual Studio Build Tools 的 C++ 工作负载）

脚本会在启动前**强制重启 backend**（结束占用 `127.0.0.1:8787` 的旧进程，再拉起新实例）。

如需在当前会话以后台任务方式启动：

```powershell
.\start.ps1 -NoNewWindow
```

**macOS / Linux（bash）**：

```bash
chmod +x ./start.sh   # 首次运行前赋权
./start.sh
```

同一个终端里同时跑前后端，Ctrl-C 一起停。默认端口 `3000` / `8787`，可覆盖：

```bash
FRONTEND_PORT=5173 BACKEND_PORT=9000 ./start.sh
```

依赖：

- Node.js + npm（`./start.sh` 会执行 `npm install` 如需，然后 `npm run dev` 起 Vite）。
- Rust 工具链（`cargo`）；macOS 上最省心的装法是 `brew install rustup-init && rustup-init`，或 `xcode-select --install` 后 `curl https://sh.rustup.rs -sSf | sh`。
- SQLite / OpenSSL 这些底层库在 macOS 上由 rusqlite 的 `bundled` feature 和 rustls 处理，通常不需要额外安装。
- 如果是 Apple Silicon，首次 `cargo run` 会拉整套 crates 并编译约 1~2 分钟。

浏览器打开 `http://localhost:3000` 开始用；**请保持 `localhost` 访问**（不要换成 `127.0.0.1`），否则 session cookie 会因为和后端不同 site 而带不上来，表现为刷新后要求重新登录。

前端会优先调用 Rust API（记录、宝宝信息、疫苗计划/设置/自定义模板），当 API 不可用时自动回退到 `localStorage`。

Rust API 持久化使用 SQLite（`backend/data/babylog.db`），并包含时间轴/分类/日期等查询索引。

图片走磁盘对象存储目录 `backend/data/objects/`（已 gitignore），对外 URL 前缀可通过环境变量 **`BABYLOG_PUBLIC_BASE`** 配置（默认 `http://127.0.0.1:8787`），便于反向代理到 HTTPS。后续若要换 S3/R2/MinIO，可替换 `upload_images` 的实现并保持 API 契约不变。

## 项目结构

```text
babylog/
  index.html      # 页面结构
  css/style.css   # 样式
  src/            # TypeScript 源码（Vite 入口 main.ts）
  scripts/        # 辅助脚本（如测试数据生成）
  backend/        # Rust API（可选）
  DESIGN.md       # UI 设计规范
```

## 数据存储说明

数据保存在浏览器本地 `localStorage`，主要键包括：

- `babylog_entries_v1`：日常记录
- `babylog_profile_v1`：宝宝信息

> 疫苗计划、疫苗提醒设置、自定义疫苗模板由 Rust API 持久化到 SQLite，不写入浏览器 `localStorage`。

> 提示：清理浏览器站点数据会导致本地记录丢失，建议定期导出 JSON 备份。

## 测试数据生成（Python）

仓库内提供脚本，可生成约一个月的随机记录，导出为 BabyLog 可导入的 JSON 数组（与「导出 JSON」格式一致）。

```bash
python scripts/generate_babylog_month.py -o babylog-sample-month.json
python scripts/generate_babylog_month.py --days 30 --seed 42 --end 2026-04-15 -o out.json
```

在应用内：**时间轴 → 导入**，选择生成的文件。若已启用 Rust API，导入会逐条写入后端。

## 疫苗模板格式（表格编辑）

在应用内的“疫苗计划 -> 编辑模板”中可直接表格化维护：

- 疫苗名
- 剂次
- 天数（相对生日）

保存后会自动出现在地区模板下拉中。

## 常见问题

### 1) 为什么图表范围和时间轴日期会有偏差？

应用已按本地日期处理筛选与统计。如仍有异常，请确认系统时区和浏览器时区一致。

### 2) 为什么收不到疫苗通知？

请确认：

- 浏览器支持 Notification
- 已点击“启用通知”并授予权限
- 有疫苗项目落入提醒范围

## License

仅用于个人/家庭记录用途，可按需自行扩展。
