"""Draws the README banner in the app's palette, light and dark.

    python scripts/make-readme-art.py

Writes docs/assets/banner-light.png and docs/assets/banner-dark.png. Needs Pillow and the
Georgia and Microsoft YaHei fonts (any Windows machine has them).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "docs" / "assets"
FONTS = Path("C:/Windows/Fonts")
W, H, SS = 1600, 560, 2

THEMES = {
    "light": dict(paper="#f6f3ed", ink="#1a1814", muted="#8a8173", gold="#9a7424", hair="#d9d4ca", card="#fbf9f5", line="#e6e0d4", glow="#efe7d6"),
    "dark": dict(paper="#14120f", ink="#ece6da", muted="#9a9083", gold="#e6c98f", hair="#3a352d", card="#1d1a16", line="#2d2923", glow="#2a241a"),
}


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), int(size * SS))


def spaced(d, x, y, text, fnt, fill, tracking):
    for ch in text:
        d.text((x, y), ch, font=fnt, fill=fill, anchor="ls")
        x += d.textlength(ch, font=fnt) + tracking * SS


def card(d, x, y, w, h, t, ring=False, pointer=None):
    s = SS
    d.rounded_rectangle([x * s, y * s, (x + w) * s, (y + h) * s], radius=14 * s, fill=t["card"], outline=t["gold"] if ring else t["hair"], width=(2 if ring else 1) * s)
    d.rounded_rectangle([(x + 14) * s, (y + 14) * s, (x + w - 14) * s, (y + 24) * s], radius=5 * s, fill=t["line"])
    for i, frac in enumerate((0.78, 0.62, 0.7)):
        yy = y + 42 + i * 16
        if yy + 8 < y + h - 10:
            d.rounded_rectangle([(x + 14) * s, yy * s, (x + 14 + (w - 28) * frac) * s, (yy + 7) * s], radius=3 * s, fill=t["line"])
    if pointer:
        px, py = x + w * pointer[0], y + h * pointer[1]
        arrow = [(px, py), (px, py + 22), (px + 6, py + 16.5), (px + 10.5, py + 25), (px + 14, py + 23.4), (px + 9.8, py + 15), (px + 17, py + 15)]
        d.polygon([(ax * s, ay * s) for ax, ay in arrow], fill=t["ink"], outline=t["card"])


def banner(name):
    t = THEMES[name]
    img = Image.new("RGB", (W * SS, H * SS), t["paper"])
    d = ImageDraw.Draw(img)
    # The wall: three lanes of live pages, the middle one drifting the other way and running off the edge.
    lanes = [(96, 0, [None, (0.55, 0.5), None, None]), (232, -70, [None, None, (0.35, 0.42), None]), (368, 40, [None, None, None, (0.6, 0.55)])]
    for y, shift, pointers in lanes:
        x = 700 + shift
        for i in range(5):
            ring = (y == 232 and i == 2)
            card(d, x, y, 196, 112, t, ring=ring, pointer=pointers[i] if i < len(pointers) else None)
            x += 216
    # Fade the wall into the paper on the left so the type sits on a clean field.
    fade = Image.new("L", (W * SS, H * SS), 0)
    fd = ImageDraw.Draw(fade)
    for i in range(260):
        fd.line([((640 + i) * SS, 0), ((640 + i) * SS, H * SS)], fill=int(255 * (1 - i / 260) ** 1.6), width=SS)
    fd.rectangle([0, 0, 640 * SS, H * SS], fill=255)
    img.paste(Image.new("RGB", img.size, t["paper"]), (0, 0), fade)
    d = ImageDraw.Draw(img)
    d.text((96 * SS, 248 * SS), "Vela", font=font("georgiaz.ttf", 120), fill=t["ink"], anchor="ls")
    spaced(d, 102 * SS, 290 * SS, "BROWSER", font("georgia.ttf", 17), t["muted"], 7)
    d.rectangle([102 * SS, 312 * SS, 142 * SS, 314 * SS], fill=t["gold"])
    d.text((102 * SS, 372 * SS), "本地优先的指纹浏览器", font=font("msyh.ttc", 30), fill=t["ink"], anchor="ls")
    d.text((102 * SS, 410 * SS), "Local-first anti-detect browser", font=font("georgiai.ttf", 21), fill=t["muted"], anchor="ls")
    OUT.mkdir(parents=True, exist_ok=True)
    img.resize((W, H), Image.LANCZOS).save(OUT / f"banner-{name}.png", optimize=True)


if __name__ == "__main__":
    for theme in THEMES:
        banner(theme)
    print("wrote docs/assets/banner-light.png, docs/assets/banner-dark.png")
