# babylog-api

Rust + Axum backend scaffold for BabyLog performance experiments.

## Run

```bash
cargo run
```

Server starts at `http://127.0.0.1:8787`.

## Persistence

Data is stored in `data/store.json`:

- `profile`
- `entries`

## Quick test

```bash
curl http://127.0.0.1:8787/health
```
