# babylog-api

Rust + Axum backend scaffold for BabyLog performance experiments.

Windows builds use the **MSVC** target (`x86_64-pc-windows-msvc`). Install [Build Tools for Visual Studio](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload so `link.exe` is available.

## Run

```bash
cargo run
```

Server starts at `http://127.0.0.1:8787`.

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
