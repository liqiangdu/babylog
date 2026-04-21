#!/usr/bin/env python3
"""
Generate one month of BabyLog-style entries as JSON for the app's import feature.

Output format: a JSON array of objects with keys:
  id, categoryId, at (ISO 8601), fields, note

Usage:
  python scripts/generate_babylog_month.py -o babylog-sample-month.json
  python scripts/generate_babylog_month.py --days 30 --seed 42
"""

from __future__ import annotations

import argparse
import json
import random
import uuid
from datetime import date, datetime, timedelta, time
from typing import Any


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.now().astimezone().tzinfo)
    return dt.astimezone().isoformat(timespec="seconds")


def _rand_time(rng: random.Random, day: date, hour_min: int, hour_max: int) -> datetime:
    h = rng.randint(hour_min, hour_max)
    m = rng.randint(0, 59)
    s = rng.randint(0, 59)
    return datetime.combine(day, time(h, m, s), tzinfo=datetime.now().astimezone().tzinfo)


def _entry(category_id: str, at: datetime, fields: dict[str, Any], note: str = "") -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "categoryId": category_id,
        "at": _iso(at),
        "fields": fields,
        "note": note,
    }


def generate_month(
    rng: random.Random,
    end_day: date,
    days: int,
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    start_day = end_day - timedelta(days=days - 1)

    feeding_sub = ["breast", "bottle", "mixed"]
    sleep_sub = ["start", "end", "nap"]
    diaper_sub = ["wet", "dirty", "both", "dry"]
    temp_place = ["armpit", "ear", "forehead"]
    supp_name = ["vd", "ad", "dha", "probiotic", "other"]
    tummy_sub = ["tummy", "grip", "roll", "other"]
    spit_sub = ["light", "moderate", "heavy"]
    pump_side = ["L", "R", "both"]

    for i in range(days):
        d = start_day + timedelta(days=i)
        # Feeding: 6–10 per day
        for _ in range(rng.randint(6, 10)):
            entries.append(
                _entry(
                    "feeding",
                    _rand_time(rng, d, 6, 23),
                    {
                        "subtype": rng.choice(feeding_sub),
                        "amountMl": rng.randint(40, 180),
                        "side": rng.choice(["", "L", "R", "both"]),
                    },
                    rng.choice(["", "打嗝后", "夜奶"]),
                )
            )

        # Sleep: 4–8 events (mix nap / start-end)
        for _ in range(rng.randint(4, 8)):
            entries.append(
                _entry(
                    "sleep",
                    _rand_time(rng, d, 0, 23),
                    {
                        "subtype": rng.choice(sleep_sub),
                        "durationMin": rng.randint(10, 200),
                    },
                    "",
                )
            )

        # Diaper: 8–14
        for _ in range(rng.randint(8, 14)):
            entries.append(
                _entry(
                    "diaper",
                    _rand_time(rng, d, 6, 22),
                    {"subtype": rng.choice(diaper_sub)},
                    "",
                )
            )

        # Bath every 1–3 days (simple: random ~40% per day)
        if rng.random() < 0.4:
            entries.append(
                _entry(
                    "bath",
                    _rand_time(rng, d, 18, 21),
                    {"durationMin": rng.randint(5, 20)},
                    "",
                )
            )

        # Temperature 0–2 / day
        for _ in range(rng.randint(0, 2)):
            entries.append(
                _entry(
                    "temperature",
                    _rand_time(rng, d, 8, 20),
                    {
                        "celsius": round(rng.uniform(36.3, 37.4), 1),
                        "place": rng.choice(temp_place),
                    },
                    "",
                )
            )

        # Supplement daily-ish
        if rng.random() < 0.85:
            entries.append(
                _entry(
                    "supplement",
                    _rand_time(rng, d, 9, 10),
                    {"name": rng.choice(supp_name), "dose": rng.choice(["1滴", "2滴", "半粒", "1粒"])},
                    "",
                )
            )

        # Tummy time 1–3
        for _ in range(rng.randint(1, 3)):
            entries.append(
                _entry(
                    "tummy_time",
                    _rand_time(rng, d, 10, 17),
                    {"subtype": rng.choice(tummy_sub), "durationMin": rng.randint(5, 25)},
                    "",
                )
            )

        # Growth ~weekly
        if d.weekday() == 0 and rng.random() < 0.6:
            entries.append(
                _entry(
                    "growth",
                    _rand_time(rng, d, 10, 11),
                    {
                        "weightKg": round(rng.uniform(4.5, 8.5), 2),
                        "heightCm": round(rng.uniform(52, 72), 1),
                        "headCm": round(rng.uniform(36, 44), 1),
                    },
                    "社区体检",
                )
            )

        # Spitup / cry / outdoor occasionally
        if rng.random() < 0.35:
            entries.append(
                _entry(
                    "spitup",
                    _rand_time(rng, d, 8, 20),
                    {"subtype": rng.choice(spit_sub)},
                    "",
                )
            )
        if rng.random() < 0.25:
            entries.append(
                _entry(
                    "cry",
                    _rand_time(rng, d, 14, 22),
                    {"durationMin": rng.randint(3, 25), "soothe": rng.choice(["抱哄", "白噪音", "喂奶安抚"])},
                    "",
                )
            )
        if rng.random() < 0.3:
            entries.append(
                _entry(
                    "outdoor",
                    _rand_time(rng, d, 15, 18),
                    {"durationMin": rng.randint(10, 45), "place": rng.choice(["小区花园", "公园", "阳台晒太阳"])},
                    "",
                )
            )

        # Pump 0–2 / day
        for _ in range(rng.randint(0, 2)):
            entries.append(
                _entry(
                    "pump",
                    _rand_time(rng, d, 2, 22),
                    {
                        "durationMin": rng.randint(10, 25),
                        "amountMl": rng.randint(30, 120),
                        "side": rng.choice(pump_side),
                    },
                    "",
                )
            )

        # Solid 0–2 (older-baby style)
        for _ in range(rng.randint(0, 2)):
            entries.append(
                _entry(
                    "solid",
                    _rand_time(rng, d, 11, 13),
                    {
                        "food": rng.choice(["米粉", "南瓜泥", "胡萝卜泥", "苹果泥", "蛋黄"]),
                        "amount": rng.choice(["小半碗", "吃完", "几口"]),
                    },
                    "",
                )
            )

        # Medicine rare
        if rng.random() < 0.08:
            entries.append(
                _entry(
                    "medicine",
                    _rand_time(rng, d, 20, 22),
                    {"name": "退烧药", "dose": "按医嘱"},
                    "发热护理",
                )
            )

        # Custom note
        if rng.random() < 0.12:
            entries.append(
                _entry(
                    "custom",
                    _rand_time(rng, d, 12, 20),
                    {},
                    rng.choice(["打疫苗观察", "游泳课", "亲友来访", "拍照留念"]),
                )
            )

    # Sort newest first (matches app behavior after save)
    entries.sort(key=lambda e: e["at"], reverse=True)
    return entries


def main() -> None:
    p = argparse.ArgumentParser(description="Generate BabyLog import JSON (one month of entries).")
    p.add_argument("-o", "--output", default="babylog-sample-month.json", help="Output JSON file path")
    p.add_argument("--days", type=int, default=30, help="Number of days to generate (default 30)")
    p.add_argument(
        "--end",
        default=None,
        help="Last calendar day YYYY-MM-DD (default: today local)",
    )
    p.add_argument("--seed", type=int, default=None, help="Random seed for reproducible output")
    args = p.parse_args()

    rng = random.Random(args.seed)
    if args.end:
        end_day = date.fromisoformat(args.end)
    else:
        end_day = date.today()

    data = generate_month(rng, end_day, max(1, args.days))
    out_path = args.output
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"Wrote {len(data)} entries to {out_path}")
    print("Import in BabyLog: 时间轴 → 导入 → choose this JSON file.")
    if args.seed is not None:
        print(f"Seed: {args.seed}")


if __name__ == "__main__":
    main()
