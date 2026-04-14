# babylog-api

Rust + Axum backend scaffold for BabyLog performance experiments.

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
