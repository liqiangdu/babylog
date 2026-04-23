# BabyLog

[Chinese version](README.md)

BabyLog is a baby growth tracking app for families. The frontend uses Vite + TypeScript, and the backend uses Rust + Axum + SQLite.

The default operating mode is **frontend + backend + authenticated usage**: business data is stored in the backend database, while the browser only keeps lightweight UI preferences.

## Architecture

- `src/`: frontend app (Vite entry: `src/main.ts`)
- `backend/`: Rust API (auth, entries, stats, uploads, AI sessions)
- `backend/data/babylog.db`: SQLite database
- `backend/data/objects/`: uploaded image objects served via `/media/*`

## Quickstart (Development)

### 1) Start frontend

```bash
npm install
npm run dev
```

Default URL is usually `http://localhost:3000`.

### 2) Start backend (required)

```bash
cd backend
cargo run
```

Default listen address is `127.0.0.1:8787` (local machine only).

### 3) Open app

Open `http://localhost:3000` in your browser.

Use `localhost` consistently (do not mix with `127.0.0.1`) to avoid `SameSite=Lax` cookie cross-site issues. The default frontend API base in `src/config/api-base.ts` is `http://localhost:8787/api`.

## Start Services Manually

Run frontend and backend in two separate terminals.

Frontend (project root):

```bash
npm install
npm run dev
```

Backend (`backend/`):

```bash
cd backend
cargo run
```

For LAN testing, set an explicit listen address:

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

- Logging: feeding, sleep, diaper, temperature, bath, medication, supplements, development
- Timeline: filter by type/date with pagination
- Baby profile: nickname, birthday, gender, blood type
- Vaccine planning: schedule management, settings, template editing
- Stats: range-based aggregation and charts
- Image uploads: multi-image upload returning `/media/...` URLs
- AI chat: streaming interface (requires `DEEPSEEK_API_KEY`)

## API Snapshot

The backend provides:

- Health: `GET /health`
- Auth: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`
- Account: `PUT /api/auth/email`, `PUT /api/auth/password`, `PUT /api/auth/avatar`
- Audit: `GET /api/audit`
- Profile: `GET/PUT /api/profile`
- Entries: `GET/POST /api/entries`, `PUT/DELETE /api/entries/:id`
- Vaccines: `GET/PUT /api/vaccines`, `GET/PUT /api/vaccine-settings`, `GET/PUT /api/vaccine-templates`
- Stats: `GET /api/stats`
- Uploads: `POST /api/uploads` (`multipart/form-data`, repeated `file` field)
- Media: `GET /media/<filename>`
- AI: `POST /api/chat/stream`, `GET/PUT /api/ai-project`

## Security Defaults and Deployment Notes

Defaults are security-oriented; relax settings only when required.

- Cookie session mode is enabled by default: `BABYLOG_COOKIE_MODE=1`
  - `babylog_session` is HttpOnly
  - write requests require `babylog_csrf` + `X-CSRF-Token` double-submit
- CORS defaults to common local dev origins; set `BABYLOG_ALLOWED_ORIGINS` explicitly in production
- `BABYLOG_CORS_PERMISSIVE=1` is for temporary local debugging only
- Behind a reverse proxy, enable:
  - `BABYLOG_COOKIE_SECURE=1`
  - `BABYLOG_HSTS=1`
  - `BABYLOG_TRUST_PROXY=1`
- Strongly recommended in production: set `BABYLOG_PEPPER`
- `BABYLOG_PUBLIC_BASE` controls the public origin used in uploaded media URLs

## Backend Environment Variables (Common)

- `BABYLOG_LISTEN`: listen address (default `127.0.0.1:8787`)
- `BABYLOG_ALLOWED_ORIGINS`: comma-separated allowed CORS origins
- `BABYLOG_CORS_PERMISSIVE`: set `1` to allow permissive CORS (dev only)
- `BABYLOG_COOKIE_MODE`: `1` for Cookie mode (default), `0` for Bearer mode
- `BABYLOG_COOKIE_SECURE`: set `1` to add `Secure` to cookies
- `BABYLOG_HSTS`: set `1` to add HSTS headers (HTTPS setups)
- `BABYLOG_TRUST_PROXY`: set `1` to trust proxy IP headers
- `BABYLOG_PEPPER`: password pepper
- `BABYLOG_PUBLIC_BASE`: public origin for media URLs
- `DEEPSEEK_API_KEY`: enables AI streaming endpoint

For full backend variables and route details, see `backend/README.md`.

## Data Persistence Model

- **Business data**: stored in `backend/data/babylog.db` (user-isolated)
- **Uploaded files**: stored in `backend/data/objects/` and served via `/media/*`
- **Browser localStorage**: UI preferences only, not primary business records

## License

MIT
