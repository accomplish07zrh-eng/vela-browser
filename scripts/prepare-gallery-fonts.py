"""Build the licensed gallery fonts from checksum-pinned local upstream sources.

Requires fonttools[woff]==4.60.1 and brotli==1.2.0. No network access.
Usage: python scripts/prepare-gallery-fonts.py --source-dir reports/gallery-font-sources
"""
import argparse
import hashlib
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "manrope-variable.ttf": "3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6",
    "noto-sans-sc-variable.ttf": "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
    "noto-serif-sc-variable.ttf": "050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    source_dir = parser.parse_args().source_dir.resolve()
    # Verify every input before writing any output.
    for name, digest in SOURCES.items():
        if hashlib.sha256((source_dir / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"Unrecognized upstream font: {name}")
    characters = set(range(0x250)) | set(range(0x400, 0x530)) | set(range(0x2000, 0x2070)) | set(range(0x3000, 0x3040))
    for locale in sorted((ROOT / "web/locales").glob("*.json")):
        characters.update(map(ord, locale.read_text(encoding="utf-8-sig")))
    for name in SOURCES:
        font = TTFont(source_dir / name, recalcTimestamp=False)
        if name.startswith("noto-serif"):
            options = subset.Options()
            options.layout_features = ["*"]
            options.notdef_glyph = True
            worker = subset.Subsetter(options=options)
            worker.populate(unicodes=characters)
            worker.subset(font)
        font.flavor = "woff2"
        output = ROOT / "web/fonts" / name.replace(".ttf", ".woff2")
        font.save(output)
        print(f"{output.name}: {output.stat().st_size} bytes, sha256 {hashlib.sha256(output.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main()
