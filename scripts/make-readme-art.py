"""Draws the README art in the app's palette, light and dark.

    python scripts/make-readme-art.py

Writes animated SVGs to docs/assets:
  banner-{light,dark}.svg   the wall: lanes drifting against each other, pointers that ease,
                            overshoot and click, a tile typing, a tile cooling and waking
  agents-{light,dark}.svg   one AI, three windows, each with its own pointer and rhythm
  cooling-{light,dark}.svg  memory crosses the line, the longest-idle browser cools, then wakes

GitHub plays CSS animation inside SVG images. Text is drawn with Pillow into an embedded PNG,
because an SVG shown as an image cannot load fonts. Needs Pillow and the Georgia and
Microsoft YaHei fonts (any Windows machine has them). Every animation stops for readers who
ask for reduced motion.
"""
import base64
import io
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "docs" / "assets"
FONTS = Path("C:/Windows/Fonts")
SS = 2

THEMES = {
    "light": dict(paper="#f6f3ed", ink="#1a1814", muted="#8a8173", gold="#9a7424", hair="#d9d4ca", card="#fbf9f5",
                  line="#e6e0d4", glow="#efe7d6", sunk="#efebe3", cooled="#b9b1a4", meter="#cfc7b8"),
    "dark": dict(paper="#14120f", ink="#ece6da", muted="#9a9083", gold="#e6c98f", hair="#3a352d", card="#1d1a16",
                 line="#2d2923", glow="#2a241a", sunk="#191713", cooled="#5a5348", meter="#3a342b"),
}

# The pointer, tip at 0,0.
ARROW = "M0 0 L0 22 L6 16.5 L10.5 25 L14 23.4 L9.8 15 L17 15 Z"
# The app's snow icon, drawn on a 24-unit grid.
SNOW = ("M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 6.5l2.5-2M9.5 19.5 12 17.5l2.5 2"
        "M4 10.6l3.3-.6-.9-3.2M20 13.4l-3.3.6.9 3.2M4 13.4l3.3.6-.9 3.2M20 10.6l-3.3-.6.9-3.2")

REDUCED = "@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }"
BOX = "transform-box: fill-box;"
# Human-like motion: accelerate, slightly overshoot the target, settle, then click.
EASE = "cubic-bezier(.45,.05,.2,1)"
SETTLE = "cubic-bezier(.3,.6,.4,1)"


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), int(size * SS))


def spaced(d, x, y, text, fnt, fill, tracking):
    for ch in text:
        d.text((x, y), ch, font=fnt, fill=fill, anchor="ls")
        x += d.textlength(ch, font=fnt) + tracking * SS


def png_uri(img):
    buffer = io.BytesIO()
    img.save(buffer, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def svg(w, h, t, style, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">\n'
            f"<style>\n{style}\n{REDUCED}\n</style>\n"
            f'<rect width="{w}" height="{h}" fill="{t["paper"]}"/>\n{body}\n</svg>\n')


def pointer(t, cls, x, y):
    """A pointer whose motion lives in its class; the outer group places its start."""
    return (f'<g transform="translate({x:.1f} {y:.1f})"><g class="{cls}">'
            f'<path d="{ARROW}" fill="{t["ink"]}" stroke="{t["card"]}" stroke-width="1.2" stroke-linejoin="round"/></g></g>')


def ripple(t, cls, x, y, r=16):
    return f'<circle class="{cls}" cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="none" stroke="{t["gold"]}" stroke-width="2"/>'


def keyframes(name, frames):
    """frames: (percent, css, easing or None). An easing applies to the segment that follows its frame."""
    rows = [f"  {pct}% {{ {css}{f' animation-timing-function: {ease};' if ease else ''} }}" for pct, css, ease in frames]
    return f"@keyframes {name} {{\n" + "\n".join(rows) + "\n}"


def glide(start_pct, end_pct, frm, to, overshoot=(4, 2)):
    """One human-like move: ease out of frm, overshoot to a little past to, settle on to."""
    (fx, fy), (tx, ty), (ox, oy) = frm, to, overshoot
    over = round(start_pct + (end_pct - start_pct) * 0.82, 2)
    return [(start_pct, f"transform: translate({fx}px,{fy}px);", EASE),
            (over, f"transform: translate({tx + ox}px,{ty + oy}px);", SETTLE),
            (end_pct, f"transform: translate({tx}px,{ty}px);", None)]


def hold(pct, at):
    return (pct, f"transform: translate({at[0]}px,{at[1]}px);", None)


def burst(name, dur, at_pct, grow=1.7, extra=None):
    """A click ripple that appears at at_pct and spreads out."""
    frames = [(0, "transform: scale(.2); opacity: 0;", None), (at_pct, "transform: scale(.2); opacity: 0;", None),
              (round(at_pct + .5, 2), "transform: scale(.25); opacity: .75;", "ease-out"),
              (round(at_pct + 9, 2), f"transform: scale({grow}); opacity: 0;", None)]
    if extra is not None:
        frames += [(round(extra, 2), f"transform: scale({grow}); opacity: 0;", None),
                   (round(extra + .5, 2), "transform: scale(.25); opacity: .75;", "ease-out"),
                   (round(extra + 5, 2), f"transform: scale({grow}); opacity: 0;", None)]
    frames.append((100, f"transform: scale({grow}); opacity: 0;", None))
    return (f".{name} {{ animation: {name} {dur}s infinite; {BOX} transform-origin: center; }}\n" + keyframes(name, frames))


def tile(t, x, y, w, h, inner="", cls="", dot_cls="live"):
    lines = "".join(
        f'<rect x="{x + 14}" y="{y + 42 + i * 16}" width="{(w - 28) * f:.1f}" height="7" rx="3" fill="{t["line"]}"/>'
        for i, f in enumerate((0.78, 0.62, 0.7)) if y + 42 + i * 16 + 8 < y + h - 10)
    return (f'<g class="{cls}">'
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{t["card"]}" stroke="{t["hair"]}"/>'
            f'<rect x="{x + 14}" y="{y + 14}" width="{w - 44}" height="10" rx="5" fill="{t["line"]}"/>'
            f'<circle class="{dot_cls}" cx="{x + w - 18}" cy="{y + 19}" r="4" fill="{t["gold"]}" stroke="{t["gold"]}" stroke-width="1.5"/>'
            f"{lines}{inner}</g>")


LIVE = (".live { animation: live 3.2s ease-in-out infinite; }\n"
        "@keyframes live { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }")


# ---------------------------------------------------------------- banner

def banner_text(t):
    """The type on the left and the fade that lets the wall run under it, as one PNG."""
    w, h = 900, 560
    # Paper colour everywhere; only its opacity fades, so the edge never greys toward black.
    img = Image.new("RGBA", (w * SS, h * SS), t["paper"])
    mask = Image.new("L", img.size, 0)
    md = ImageDraw.Draw(mask)
    md.rectangle([0, 0, 640 * SS, h * SS], fill=255)
    for i in range(260 * SS):
        md.line([(640 * SS + i, 0), (640 * SS + i, h * SS)], fill=int(255 * (1 - i / (260 * SS)) ** 1.6))
    img.putalpha(mask)
    d = ImageDraw.Draw(img)
    d.text((96 * SS, 248 * SS), "Vela", font=font("georgiaz.ttf", 120), fill=t["ink"], anchor="ls")
    spaced(d, 102 * SS, 290 * SS, "BROWSER", font("georgia.ttf", 17), t["muted"], 7)
    d.rectangle([102 * SS, 312 * SS, 142 * SS, 314 * SS], fill=t["gold"])
    d.text((102 * SS, 372 * SS), "本地优先的指纹浏览器", font=font("msyh.ttc", 30), fill=t["ink"], anchor="ls")
    d.text((102 * SS, 410 * SS), "Local-first anti-detect browser", font=font("georgiai.ttf", 21), fill=t["muted"], anchor="ls")
    return png_uri(img), w, h


def banner(name):
    t = THEMES[name]
    W, H, TW, TH, GAP = 1600, 560, 196, 112, 20
    STEP = TW + GAP
    PERIOD = STEP * 5
    uri, ow, oh = banner_text(t)
    a_to = (62, 18)
    style = [
        ".lane-l { animation: drift-l 64s linear infinite; }",
        ".lane-r { animation: drift-r 76s linear infinite; }",
        f"@keyframes drift-l {{ from {{ transform: translateX(0); }} to {{ transform: translateX(-{PERIOD}px); }} }}",
        f"@keyframes drift-r {{ from {{ transform: translateX(-{PERIOD}px); }} to {{ transform: translateX(0); }} }}",
        LIVE,
        # Top lane: the main browser clicks; its followers echo the click at the same moment.
        ".cur-a { animation: cur-a 8s infinite; }",
        keyframes("cur-a", glide(0, 30, (0, 0), a_to, (5, 2)) + [hold(40, a_to)] + glide(40, 70, a_to, (-14, 34), (-4, 2))
                  + glide(70, 96, (-14, 34), (0, 0), (2, -2)) + [hold(100, (0, 0))]),
        burst("sync", 8, 30),
        # Middle lane: the focused browser, typing in bursts.
        ".ring { animation: ring 5s ease-in-out infinite; }",
        "@keyframes ring { 0%, 100% { stroke-opacity: 1; } 50% { stroke-opacity: .4; } }",
        f".type {{ animation: type 7s infinite; {BOX} transform-origin: left center; }}",
        keyframes("type", [(0, "transform: scaleX(0);", "steps(9, end)"), (22, "transform: scaleX(.55);", None),
                           (30, "transform: scaleX(.55);", "steps(7, end)"), (52, "transform: scaleX(1);", None),
                           (88, "transform: scaleX(1);", None), (92, "transform: scaleX(0);", None), (100, "transform: scaleX(0);", None)]),
        ".caret { animation: caret 7s infinite; }",
        keyframes("caret", [(0, "transform: translateX(0px);", "steps(9, end)"), (22, "transform: translateX(73px);", None),
                            (30, "transform: translateX(73px);", "steps(7, end)"), (52, "transform: translateX(133px);", None),
                            (88, "transform: translateX(133px);", None), (92, "transform: translateX(0px);", None), (100, "transform: translateX(0px);", None)]),
        ".blink { animation: blink 1s steps(2, start) infinite; }",
        "@keyframes blink { to { visibility: hidden; } }",
        ".cur-b { animation: cur-b 11s infinite; }",
        keyframes("cur-b", glide(0, 18, (0, 0), (-38, 22), (-3, 3)) + [hold(60, (-38, 22))]
                  + glide(60, 84, (-38, 22), (0, 0), (2, -2)) + [hold(100, (0, 0))]),
        # Bottom lane: a browser nobody touched cools, then a double-click wakes it.
        ".cool { animation: cool 14s infinite; }",
        keyframes("cool", [(0, "opacity: 1;", None), (34, "opacity: 1;", "ease-in-out"), (42, "opacity: .32;", None),
                           (76, "opacity: .32;", "ease-out"), (80, "opacity: 1;", None), (100, "opacity: 1;", None)]),
        ".cool-dot { animation: cool-dot 14s infinite; }",
        keyframes("cool-dot", [(0, "fill-opacity: 1;", None), (38, "fill-opacity: 1;", None), (40, "fill-opacity: 0;", None),
                               (78, "fill-opacity: 0;", None), (80, "fill-opacity: 1;", None), (100, "fill-opacity: 1;", None)]),
        f".snow {{ animation: snow 14s infinite; {BOX} transform-origin: center; }}",
        keyframes("snow", [(0, "opacity: 0; transform: rotate(-30deg) scale(.6);", None),
                           (38, "opacity: 0; transform: rotate(-30deg) scale(.6);", "ease-out"),
                           (46, "opacity: 1; transform: rotate(0deg) scale(1);", None),
                           (74, "opacity: 1; transform: rotate(0deg) scale(1);", "ease-in"),
                           (78, "opacity: 0; transform: rotate(20deg) scale(.6);", None), (100, "opacity: 0;", None)]),
        ".cur-c { animation: cur-c 14s infinite; }",
        keyframes("cur-c", [(0, "transform: translate(70px,60px); opacity: 0;", None), (56, "transform: translate(70px,60px); opacity: 0;", None),
                            (58, "transform: translate(70px,60px); opacity: 1;", EASE), (69, "transform: translate(4px,-2px); opacity: 1;", SETTLE),
                            (72, "transform: translate(0px,0px); opacity: 1;", None), (88, "transform: translate(0px,0px); opacity: 1;", None),
                            (92, "transform: translate(0px,0px); opacity: 0;", None), (100, "transform: translate(70px,60px); opacity: 0;", None)]),
        burst("wake", 14, 73, 1.5, extra=76.5),
    ]

    def lane(y, shift, cls, variant):
        x0 = 700 + shift - STEP
        return f'<g class="{cls}">' + "".join(variant(i % 5, x0 + i * STEP, y) for i in range(13)) + "</g>"

    def top(k, x, y):
        px, py = x + TW * 0.36, y + TH * 0.42
        if k == 1:
            return tile(t, x, y, TW, TH, ripple(t, "sync", px + a_to[0], py + a_to[1]) + pointer(t, "cur-a", px, py))
        if k in (3, 4):
            return tile(t, x, y, TW, TH, ripple(t, "sync", px + a_to[0], py + a_to[1]))
        return tile(t, x, y, TW, TH)

    def middle(k, x, y):
        if k != 2:
            return tile(t, x, y, TW, TH)
        return (f'<g><rect x="{x}" y="{y}" width="{TW}" height="{TH}" rx="14" fill="{t["card"]}"/>'
                f'<rect class="ring" x="{x}" y="{y}" width="{TW}" height="{TH}" rx="14" fill="none" stroke="{t["gold"]}" stroke-width="2"/>'
                f'<rect x="{x + 14}" y="{y + 14}" width="{TW - 44}" height="10" rx="5" fill="{t["line"]}"/>'
                f'<rect x="{x + 14}" y="{y + 40}" width="{(TW - 28) * .6:.1f}" height="7" rx="3" fill="{t["line"]}"/>'
                f'<circle class="live" cx="{x + TW - 18}" cy="{y + 19}" r="4" fill="{t["gold"]}"/>'
                f'<rect x="{x + 14}" y="{y + 66}" width="{TW - 28}" height="26" rx="8" fill="{t["sunk"]}" stroke="{t["hair"]}"/>'
                f'<rect class="type" x="{x + 24}" y="{y + 76}" width="133" height="7" rx="3" fill="{t["muted"]}"/>'
                f'<g class="caret"><rect class="blink" x="{x + 25}" y="{y + 72}" width="2" height="15" fill="{t["gold"]}"/></g>'
                + pointer(t, "cur-b", x + TW * 0.55, y + TH * 0.32) + "</g>")

    def bottom(k, x, y):
        if k != 3:
            return tile(t, x, y, TW, TH)
        sx, sy = x + TW / 2 - 18, y + TH / 2 - 14
        px, py = x + TW * 0.5, y + TH * 0.5
        return (tile(t, x, y, TW, TH, cls="cool", dot_cls="cool-dot")
                + f'<g transform="translate({sx} {sy}) scale(1.5)"><path class="snow" d="{SNOW}" fill="none" '
                  f'stroke="{t["ink"]}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></g>'
                + ripple(t, "wake", px, py, 18) + pointer(t, "cur-c", px, py))

    body = (lane(96, 0, "lane-l", top) + lane(232, -70, "lane-r", middle) + lane(368, 40, "lane-l", bottom)
            + f'<image href="{uri}" x="0" y="0" width="{ow}" height="{oh}"/>')
    return svg(W, H, t, "\n".join(style), body)


# ---------------------------------------------------------------- agents

def agents(name):
    t = THEMES[name]
    W, H = 1600, 560
    WW, WH, Y = 440, 330, 180
    xs = (96, 580, 1064)
    durations = (9, 11.5, 13.5)
    style = [".flow { stroke-dasharray: 2 12; animation: flow 1.4s linear infinite; }",
             "@keyframes flow { to { stroke-dashoffset: -28; } }",
             f".hub {{ animation: hub 3s ease-in-out infinite; {BOX} transform-origin: center; }}",
             "@keyframes hub { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.22); opacity: .35; } }"]
    body = []
    hx, hy = W / 2, 70
    # One AI connection, with work flowing down to each window.
    for i, x in enumerate(xs):
        cx = x + WW / 2
        path = f"M{hx} {hy + 24} C {hx} {hy + 72}, {cx} {Y - 66}, {cx} {Y - 8}"
        body.append(f'<path d="{path}" fill="none" stroke="{t["hair"]}" stroke-width="1.5"/>')
        body.append(f'<path class="flow" d="{path}" fill="none" stroke="{t["gold"]}" stroke-width="2.4" stroke-linecap="round" style="animation-delay:-{i * .45}s"/>')
    body.append(f'<circle class="hub" cx="{hx}" cy="{hy}" r="32" fill="none" stroke="{t["gold"]}" stroke-width="1.5"/>')
    body.append(f'<circle cx="{hx}" cy="{hy}" r="24" fill="{t["ink"]}"/>')
    s = 11  # a four-point spark
    body.append(f'<path d="M{hx} {hy - s} Q{hx + 2} {hy - 2} {hx + s} {hy} Q{hx + 2} {hy + 2} {hx} {hy + s} '
                f'Q{hx - 2} {hy + 2} {hx - s} {hy} Q{hx - 2} {hy - 2} {hx} {hy - s} Z" fill="{t["paper"]}"/>')
    for i, (x, dur) in enumerate(zip(xs, durations)):
        n = f"w{i}"
        fx, fy, fw, fh = x + 32, Y + 150, WW - 64, 40
        bx, by, bw, bh = x + 32, Y + 214, 120, 38
        start = (WW - 110 - i * 30, 70 + i * 18)
        to_field = (70 + i * 46, 168)
        to_button = (84, 234)
        style.append(f".cur-{n} {{ animation: cur-{n} {dur}s infinite; }}")
        style.append(keyframes(f"cur-{n}", glide(0, 16, start, to_field, (5, 3)) + [hold(46, to_field)]
                               + glide(46, 60, to_field, to_button, (-3, 4)) + [hold(72, to_button)]
                               + glide(72, 94, to_button, start, (6, -4)) + [hold(100, start)]))
        style.append(burst(f"clk-{n}", dur, 16, 1.8))
        style.append(burst(f"bclk-{n}", dur, 60, 1.8))
        style.append(f".press-{n} {{ animation: press-{n} {dur}s infinite; {BOX} transform-origin: center; }}")
        style.append(keyframes(f"press-{n}", [(0, "transform: scale(1);", None), (60, "transform: scale(1);", None),
                                              (61, "transform: scale(.93);", None), (64, "transform: scale(1);", None), (100, "transform: scale(1);", None)]))
        # Typing in bursts and pauses; each window keeps its own cadence.
        typing = [(0, "transform: scaleX(0);", None), (18, "transform: scaleX(0);", f"steps({5 + i * 2}, end)"),
                  (25 + i, "transform: scaleX(.38);", None), (29 + i, "transform: scaleX(.38);", f"steps({4 + i}, end)"),
                  (36, f"transform: scaleX({.7 + i * .05:.2f});", None), (39, f"transform: scaleX({.7 + i * .05:.2f});", f"steps({3 + i}, end)"),
                  (45, "transform: scaleX(1);", None), (93, "transform: scaleX(1);", None), (96, "transform: scaleX(0);", None),
                  (100, "transform: scaleX(0);", None)]
        style.append(f".type-{n} {{ animation: type-{n} {dur}s infinite; {BOX} transform-origin: left center; }}")
        style.append(keyframes(f"type-{n}", typing))
        body.append(
            f'<g><rect x="{x}" y="{Y}" width="{WW}" height="{WH}" rx="16" fill="{t["card"]}" stroke="{t["hair"]}"/>'
            f'<path d="M{x} {Y + 40} H{x + WW}" stroke="{t["hair"]}"/>'
            + "".join(f'<circle cx="{x + 22 + k * 16}" cy="{Y + 20}" r="4.5" fill="{t["line"]}"/>' for k in range(3))
            + f'<rect x="{x + 80}" y="{Y + 12}" width="{WW - 120}" height="16" rx="8" fill="{t["sunk"]}"/>'
            f'<circle class="live" cx="{x + WW - 26}" cy="{Y + 20}" r="4" fill="{t["gold"]}" style="animation-delay:-{i}s"/>'
            f'<rect x="{x + 32}" y="{Y + 66}" width="{WW * .46:.0f}" height="14" rx="6" fill="{t["line"]}"/>'
            f'<rect x="{x + 32}" y="{Y + 96}" width="{WW * .72:.0f}" height="8" rx="4" fill="{t["line"]}"/>'
            f'<rect x="{x + 32}" y="{Y + 114}" width="{WW * .6:.0f}" height="8" rx="4" fill="{t["line"]}"/>'
            f'<rect x="{fx}" y="{fy}" width="{fw}" height="{fh}" rx="10" fill="{t["sunk"]}" stroke="{t["hair"]}"/>'
            f'<rect class="type-{n}" x="{fx + 16}" y="{fy + 16}" width="{fw - 48 - i * 30}" height="8" rx="4" fill="{t["muted"]}"/>'
            f'<g class="press-{n}"><rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="10" fill="{t["ink"]}"/>'
            f'<rect x="{bx + 30}" y="{by + 15}" width="{bw - 60}" height="8" rx="4" fill="{t["paper"]}" fill-opacity=".7"/></g>'
            f'<rect x="{x + WW - 130}" y="{by + 15}" width="98" height="8" rx="4" fill="{t["line"]}"/>'
            + ripple(t, f"clk-{n}", x + to_field[0], Y + to_field[1], 18)
            + ripple(t, f"bclk-{n}", x + to_button[0], Y + to_button[1], 18)
            + pointer(t, f"cur-{n}", x, Y) + "</g>")
    style.append(LIVE)
    return svg(W, H, t, "\n".join(style), "\n".join(body))


# ---------------------------------------------------------------- cooling

def cooling(name):
    t = THEMES[name]
    W, H, D = 1600, 420, 16
    # Meter and tiles centred as one group.
    MX, MY, MW, MH = 200, 70, 46, 280
    THRESH = .85
    TX, TY, TW, TH, GAP = 380, 150, 190, 124, 22
    style = [
        f".level {{ animation: level {D}s infinite; {BOX} transform-origin: bottom; }}",
        keyframes("level", [(0, "transform: scaleY(.62);", "cubic-bezier(.5,0,.8,.6)"), (34, "transform: scaleY(.91);", None),
                            (40, "transform: scaleY(.91);", "cubic-bezier(.2,.8,.3,1)"), (50, "transform: scaleY(.68);", None),
                            (74, "transform: scaleY(.68);", "ease-in-out"), (84, "transform: scaleY(.74);", None),
                            (96, "transform: scaleY(.74);", "ease-in-out"), (100, "transform: scaleY(.62);", None)]),
        ".hot { animation: hot 16s infinite; }",
        keyframes("hot", [(0, "opacity: 0;", None), (28, "opacity: 0;", None), (31, "opacity: 1;", None),
                          (44, "opacity: 1;", None), (48, "opacity: 0;", None), (100, "opacity: 0;", None)]),
        ".cool { animation: cool 16s infinite; }",
        keyframes("cool", [(0, "opacity: 1;", None), (35, "opacity: 1;", "ease-in-out"), (42, "opacity: .32;", None),
                           (76, "opacity: .32;", "ease-out"), (80, "opacity: 1;", None), (100, "opacity: 1;", None)]),
        ".cool-dot { animation: cool-dot 16s infinite; }",
        keyframes("cool-dot", [(0, "fill-opacity: 1;", None), (37, "fill-opacity: 1;", None), (39, "fill-opacity: 0;", None),
                               (78, "fill-opacity: 0;", None), (80, "fill-opacity: 1;", None), (100, "fill-opacity: 1;", None)]),
        f".snow {{ animation: snow 16s infinite; {BOX} transform-origin: center; }}",
        keyframes("snow", [(0, "opacity: 0; transform: rotate(-40deg) scale(.5);", None),
                           (37, "opacity: 0; transform: rotate(-40deg) scale(.5);", "ease-out"),
                           (46, "opacity: 1; transform: rotate(0deg) scale(1);", None),
                           (74, "opacity: 1; transform: rotate(0deg) scale(1);", "ease-in"),
                           (79, "opacity: 0; transform: rotate(25deg) scale(.5);", None), (100, "opacity: 0;", None)]),
        ".drift { animation: drift 16s infinite; }",
        keyframes("drift", [(0, "transform: translate(0,0); opacity: 0;", None), (40, "transform: translate(0,0); opacity: 0;", None),
                            (41, "transform: translate(0,0); opacity: .9;", "cubic-bezier(.3,.1,.3,1)"),
                            (54, "transform: translate(var(--dx),-70px); opacity: 0;", None), (100, "opacity: 0;", None)]),
        ".cur { animation: cur 16s infinite; }",
        keyframes("cur", [(0, "transform: translate(150px,120px); opacity: 0;", None), (58, "transform: translate(150px,120px); opacity: 0;", None),
                          (60, "transform: translate(150px,120px); opacity: 1;", EASE), (69, "transform: translate(-4px,3px); opacity: 1;", SETTLE),
                          (72, "transform: translate(0px,0px); opacity: 1;", None), (86, "transform: translate(0px,0px); opacity: 1;", None),
                          (90, "transform: translate(0px,0px); opacity: 0;", None), (100, "opacity: 0;", None)]),
        burst("wake", D, 73, 1.6, extra=76.5),
        LIVE,
    ]
    ty = MY + MH * (1 - THRESH)
    body = [
        # The memory meter: its threshold, and the level that crosses it and turns gold.
        f'<rect x="{MX}" y="{MY}" width="{MW}" height="{MH}" rx="14" fill="{t["sunk"]}" stroke="{t["hair"]}"/>',
        f'<rect class="level" x="{MX + 6}" y="{MY + 6}" width="{MW - 12}" height="{MH - 12}" rx="9" fill="{t["meter"]}"/>',
        f'<g class="hot"><rect class="level" x="{MX + 6}" y="{MY + 6}" width="{MW - 12}" height="{MH - 12}" rx="9" fill="{t["gold"]}"/></g>',
        f'<path d="M{MX - 18} {ty} H{MX + MW + 18}" stroke="{t["gold"]}" stroke-width="2" stroke-dasharray="5 5"/>',
        f'<path d="M{MX + MW + 24} {ty} l12 -7 v14 z" fill="{t["gold"]}"/>',
    ]
    for i in range(5):
        x = TX + i * (TW + GAP)
        if i:
            body.append(tile(t, x, TY, TW, TH))
            continue
        body.append(tile(t, x, TY, TW, TH, cls="cool", dot_cls="cool-dot"))
        sx, sy = x + TW / 2 - 21, TY + TH / 2 - 18
        body.append(f'<g transform="translate({sx} {sy}) scale(1.75)"><path class="snow" d="{SNOW}" fill="none" '
                    f'stroke="{t["ink"]}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></g>')
        # The memory it hands back, rising toward the meter.
        for k in range(4):
            body.append(f'<circle class="drift" cx="{x + 30 + k * 44}" cy="{TY - 8}" r="3.5" fill="{t["gold"]}" '
                        f'style="--dx:{-60 - k * 30}px; animation-delay:{k * .18}s"/>')
        px, py = x + TW * .5, TY + TH * .55
        body.append(ripple(t, "wake", px, py, 20))
        body.append(pointer(t, "cur", px, py))
    return svg(W, H, t, "\n".join(style), "\n".join(body))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for theme in THEMES:
        for kind, draw in (("banner", banner), ("agents", agents), ("cooling", cooling)):
            (OUT / f"{kind}-{theme}.svg").write_text(draw(theme), encoding="utf-8", newline="\n")
    print("wrote docs/assets/{banner,agents,cooling}-{light,dark}.svg")
