"""Draws the Windows installer bitmaps and the macOS disk-image background.

Warm paper, ink and a single gold hairline, matching the app's light theme.
The app icon is used as it is. Run from the repository root:
    python scripts/make-installer-art.py
Needs Pillow and the Georgia and Microsoft YaHei fonts (any Windows machine has them).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent / "src-tauri"
PAPER, INK, GOLD, HAIR, MUTED = "#f6f3ed", "#1a1814", "#9a7424", "#d9d4ca", "#8a8173"
FONTS = Path("C:/Windows/Fonts")
SS = 4  # supersampling for smooth edges


def font(name: str, size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), int(size * SS), index=index)


def spaced(draw, xy, text, fnt, fill, tracking, anchor="m"):
    """Letter-spaced text; xy is the centre (anchor m) or left (anchor l) of the run."""
    widths = [draw.textlength(ch, font=fnt) for ch in text]
    total = sum(widths) + tracking * SS * (len(text) - 1)
    x, y = xy
    x = x - total / 2 if anchor == "m" else x
    for ch, w in zip(text, widths):
        draw.text((x, y), ch, font=fnt, fill=fill, anchor="ls")
        x += w + tracking * SS


def icon(size: int) -> Image.Image:
    return Image.open(ROOT / "icons" / "icon.png").convert("RGBA").resize((size * SS, size * SS), Image.LANCZOS)


def finish(img: Image.Image, scale: int = 1) -> Image.Image:
    w, h = img.size
    return img.resize((w // SS * scale // 1, h // SS * scale // 1), Image.LANCZOS) if scale != 1 else img.resize((w // SS, h // SS), Image.LANCZOS)


def sidebar() -> Image.Image:
    w, h = 164, 314
    img = Image.new("RGB", (w * SS, h * SS), PAPER)
    d = ImageDraw.Draw(img)
    d.rectangle([(w - 1) * SS, 0, w * SS, h * SS], fill=HAIR)
    ic = icon(84)
    img.paste(ic, ((w - 84) // 2 * SS - SS // 2, 70 * SS), ic)
    spaced(d, (w * SS / 2 - SS, 204 * SS), "BROWSER", font("georgia.ttf", 11), INK, 3.2)
    d.rectangle([(w // 2 - 11) * SS, 218 * SS, (w // 2 + 11) * SS, 219 * SS], fill=GOLD)
    d.text((w * SS / 2, 244 * SS), "纯净桌面版", font=font("msyh.ttc", 11), fill=MUTED, anchor="ms")
    return finish(img)


def header() -> Image.Image:
    w, h = 150, 57
    img = Image.new("RGB", (w * SS, h * SS), PAPER)
    d = ImageDraw.Draw(img)
    d.rectangle([0, (h - 1) * SS, w * SS, h * SS], fill=HAIR)
    ic = icon(40)
    img.paste(ic, ((w - 48) * SS, 8 * SS), ic)
    return finish(img)


def dmg(scale: int) -> Image.Image:
    w, h = 660, 400
    img = Image.new("RGB", (w * SS, h * SS), PAPER)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([28 * SS, 24 * SS, (w - 28) * SS, (h - 24) * SS], radius=26 * SS, outline=HAIR, width=SS)
    d.text((w * SS / 2, 66 * SS), "Vela", font=font("georgiaz.ttf", 34), fill=INK, anchor="ms")
    spaced(d, (w * SS / 2, 88 * SS), "BROWSER", font("georgia.ttf", 10), MUTED, 3.4)
    d.rectangle([(w // 2 - 12) * SS, 100 * SS, (w // 2 + 12) * SS, 101 * SS], fill=GOLD)
    cx, cy, r = w // 2, 185, 23
    d.ellipse([(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS], fill="#fbf9f5", outline=HAIR, width=SS)
    d.line([(cx - 9) * SS, cy * SS, (cx + 9) * SS, cy * SS], fill=INK, width=int(1.8 * SS))
    d.line([(cx + 3) * SS, (cy - 6) * SS, (cx + 9) * SS, cy * SS, (cx + 3) * SS, (cy + 6) * SS], fill=INK, width=int(1.8 * SS), joint="curve")
    label = "将 Vela Browser 拖入 Applications 文件夹完成安装"
    f = font("msyh.ttc", 12)
    tw = d.textlength(label, font=f) / SS
    x0, x1 = (w - tw) / 2 - 22, (w + tw) / 2 + 22
    d.rounded_rectangle([x0 * SS, 314 * SS, x1 * SS, 346 * SS], radius=16 * SS, fill="#fbf9f5", outline=HAIR, width=SS)
    d.text((w * SS / 2, 335 * SS), label, font=f, fill=INK, anchor="ms")
    out = img.resize((w * scale, h * scale), Image.LANCZOS)
    return out


if __name__ == "__main__":
    sidebar().save(ROOT / "windows" / "sidebar.bmp")
    header().save(ROOT / "windows" / "header.bmp")
    dmg(1).save(ROOT / "macos" / "dmg-background.png")
    dmg(2).save(ROOT / "macos" / "dmg-background@2x.png")
    print("wrote sidebar.bmp, header.bmp, dmg-background.png, dmg-background@2x.png")
