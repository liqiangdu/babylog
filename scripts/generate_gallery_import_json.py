#!/usr/bin/env python3
"""
Generate importable BabyLog JSON entries using local gallery images.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    image_dir = root / "test-images" / "baby-gallery"
    output_file = root / "test-images" / "baby-gallery-import.json"

    image_files = sorted(image_dir.glob("baby-*.jpg"))
    if not image_files:
        raise SystemExit(f"No images found in: {image_dir}")

    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    entries = []
    for idx, image in enumerate(image_files):
        # Spread entries across recent days/times for more realistic timeline testing.
        at = now - timedelta(hours=idx * 3)
        rel_path = image.relative_to(root).as_posix()
        entries.append(
            {
                "id": str(uuid.uuid4()),
                "categoryId": "custom",
                "at": at.isoformat().replace("+00:00", "Z"),
                "fields": {},
                "note": f"画廊测试图片 #{idx + 1}",
                "photos": [rel_path],
            }
        )

    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Generated {len(entries)} entries -> {output_file}")


if __name__ == "__main__":
    main()
