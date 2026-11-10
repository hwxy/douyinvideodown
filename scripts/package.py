#!/usr/bin/env python3
"""Package the extension using only Python's standard library."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def main():
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    files = [
        "manifest.json", "background.js", "extractor.js", "reader.js", "lib.js",
        "popup.html", "popup.css", "popup.js", "help.html", "help.css", "README.md",
        "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png",
    ]
    for name in files:
        if not (root / name).is_file():
            raise SystemExit(f"Missing extension file: {name}")
    output = root / "dist" / f"douyin-video-downloader-v{version}.zip"
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for name in files:
            archive.write(root / name, f"douyin-video-downloader/{name}")
    with ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise SystemExit("ZIP verification failed")
    print(f"Created {output.relative_to(root)} ({output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
