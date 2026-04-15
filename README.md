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

- 纯前端静态应用（HTML + CSS + JavaScript）
- 浏览器 `localStorage` 持久化
- 可选 Rust 后端（Axum + Tokio）用于高性能 API

## 快速开始

### 方式 1：直接打开

1. 进入项目目录
2. 双击 `index.html` 用浏览器打开

### 方式 2：本地静态服务（推荐）

```bash
npx --yes serve .
```

打开终端输出的本地地址即可访问。

### 方式 3：运行 Rust API（可选）

> 目录：`backend/`

```bash
cd backend
cargo run
```

默认监听 `http://127.0.0.1:8787`，提供：

- `GET /health`
- `GET/PUT /api/profile`
- `GET/POST /api/entries`
- `DELETE /api/entries/:id`
- `POST /api/uploads`（multipart，字段名 `file`，返回 `{ "urls": ["…/media/<uuid>.jpg"] }`）
- `GET /media/<file>`（静态图片，高性能直出）
- `GET /api/stats`

### 一键启动（前端 + Rust API）

在项目根目录执行：

```powershell
.\start.ps1
```

会自动打开两个 PowerShell 窗口：

- 前端静态服务（`npx --yes serve .`）
- Rust API（使用默认 MSVC 工具链执行 `cargo run`，需已安装 Visual Studio Build Tools 的 C++ 工作负载）

脚本会在启动前**强制重启 backend**（结束占用 `127.0.0.1:8787` 的旧进程，再拉起新实例）。

如需在当前会话以后台任务方式启动：

```powershell
.\start.ps1 -NoNewWindow
```

前端会优先调用 Rust API（记录、宝宝信息、疫苗计划/设置/自定义模板），当 API 不可用时自动回退到 `localStorage`。

Rust API 持久化使用 SQLite（`backend/data/babylog.db`），并包含时间轴/分类/日期等查询索引。

图片走磁盘对象存储目录 `backend/data/objects/`（已 gitignore），对外 URL 前缀可通过环境变量 **`BABYLOG_PUBLIC_BASE`** 配置（默认 `http://127.0.0.1:8787`），便于反向代理到 HTTPS。后续若要换 S3/R2/MinIO，可替换 `upload_images` 的实现并保持 API 契约不变。

## 项目结构

```text
babylog/
  index.html      # 页面结构
  css/style.css   # 样式
  js/app.js       # 业务逻辑
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
