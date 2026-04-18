# babylog-api

Rust + Axum backend scaffold for BabyLog performance experiments.

Windows builds use the **MSVC** target (`x86_64-pc-windows-msvc`). Install [Build Tools for Visual Studio](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload so `link.exe` is available.

## Object storage (images)

- Uploaded files are stored under `data/objects/` with random UUID filenames (jpeg/png/gif/webp, magic-byte validated, max **8MB** each).
- Served at **`GET /media/<filename>`** via `tower-http` static file service (efficient streaming, browser cacheable).
- **`POST /api/uploads`**: `multipart/form-data`, repeat field name **`file`**. Response: `{ "urls": ["<public>/media/<uuid>.jpg", ...] }`.
- Set **`BABYLOG_PUBLIC_BASE`** (e.g. `https://api.example.com`) so returned URLs match your public origin when behind a reverse proxy. Default: `http://127.0.0.1:8787`.

To swap in S3-compatible storage (R2, MinIO, AWS S3), replace the body of `upload_images` to PUT objects remotely and return their HTTPS URLs; keep the same JSON response shape.

## Run

```bash
cargo run
```

By default the server listens on **`127.0.0.1:8787`** (local-only). For LAN access from phones or other machines:

```bash
BABYLOG_LISTEN=0.0.0.0:8787 cargo run
```

Also set **`BABYLOG_ALLOWED_ORIGINS`** to include your dev frontend origin (e.g. `http://192.168.1.5:3000`) and point the frontend **`VITE_API_BASE`** at `http://<host>:8787/api`.

## Persistence

Data is stored in SQLite: `data/babylog.db`.

Core tables:

- `profile`
- `entries`
- `vaccines`
- `vaccine_settings`
- `vaccine_templates`

Indexes:

- `entries(at DESC)`
- `entries(day)`
- `entries(category_id)`
- `entries(category_id, day)`
- `vaccines(due_date)`
- `vaccines(status)`

## Quick test

```bash
curl http://127.0.0.1:8787/health
```
