"""Makes the app's serif title face: Noto Serif SC (OFL) at weight 700, cut down to the characters
the app's Kotlin source uses. Run it again after adding title text, or new characters fall back to
the system sans face.

    python android/tools/subset_fonts.py <path to NotoSerifSC[wght].ttf>

The source font is the same one the desktop gallery is built from (web/fonts/README.md).
"""
import pathlib
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

here = pathlib.Path(__file__).resolve().parent
app = here.parent / "app" / "src" / "main"
source = pathlib.Path(sys.argv[1])
target = app / "res" / "font" / "noto_serif_sc_bold.ttf"

text = set()
for file in (app / "java").rglob("*.kt"):
    for literal in re.findall(r'"((?:[^"\\]|\\.)*)"', file.read_text(encoding="utf-8")):
        text.update(literal)
# Digits, Latin letters and common punctuation for names and numbers inside titles.
text.update(chr(c) for c in range(0x20, 0x7F))
text.update("，。、：；！？「」『』（）《》—…·")

font = TTFont(source)
bold = instancer.instantiateVariableFont(font, {"wght": 700})
options = subset.Options()
options.layout_features = ["*"]
options.name_IDs = ["*"]
options.notdef_outline = True
subsetter = subset.Subsetter(options)
subsetter.populate(text="".join(sorted(text)))
subsetter.subset(bold)
bold.save(target)
print(f"{target.name}: {len(text)} characters, {target.stat().st_size // 1024} KB")
