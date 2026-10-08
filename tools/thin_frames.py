"""
Make the character-select slot frames (borders.png) thinner without
distorting their details: a 9-slice rebuild where corners and the square
"knobs" in the middle of each side are scaled down uniformly and only the
plain stretches of the band are stretched. Outer size stays the same, so the
window for the portrait grows.

Usage: python tools/thin_frames.py [k]     (k = thickness factor, default 0.6)
Writes public/assets/ui/slot-frame.webp and slot-frame-active.webp.
"""
import math
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'borders.png')
OUT = os.path.join(ROOT, 'public', 'assets', 'ui')

C = 887                       # canvas per frame on the sheet
BODY = (45, 76, 840, 806)     # frame body inside the canvas (without glow)
CORNER = 230                  # corner bracket size (px from the body edge)
KNOB_H = (408, 476)           # x-range of the knobs on top/bottom edges
KNOB_V = (406, 476)           # y-range of the knobs on left/right edges
OUT_SIZE = 400


def thin(src: Image.Image, k: float) -> Image.Image:
    bx0, by0, bx1, by1 = BODY
    out = Image.new('RGBA', (C, C), (0, 0, 0, 0))

    def put(box, dest_x, dest_y, w, h):
        # integer destination from floor/ceil edges plus 1px overlap, so the
        # pieces never leave transparent seams between each other
        x0, y0 = math.floor(dest_x), math.floor(dest_y)
        x1, y1 = math.ceil(dest_x + w) + 1, math.ceil(dest_y + h) + 1
        piece = src.crop(box)
        out.alpha_composite(piece.resize((max(1, x1 - x0), max(1, y1 - y0)), Image.LANCZOS), (x0, y0))

    # source cut lines
    sx = [0, bx0, bx0 + CORNER, bx1 - CORNER, bx1, C]
    sy = [0, by0, by0 + CORNER, by1 - CORNER, by1, C]
    # destination: everything outside the body edge scales with k too (glow)
    dx_l = lambda x: bx0 + (x - bx0) * k          # noqa: E731  left side, around bx0
    dx_r = lambda x: bx1 - (bx1 - x) * k          # noqa: E731  right side, around bx1
    dy_t = lambda y: by0 + (y - by0) * k          # noqa: E731
    dy_b = lambda y: by1 - (by1 - y) * k          # noqa: E731

    # corners (uniform k)
    for (x0, x1, fx), (y0, y1, fy) in [
        ((sx[0], sx[2], dx_l), (sy[0], sy[2], dy_t)),
        ((sx[3], sx[5], dx_r), (sy[0], sy[2], dy_t)),
        ((sx[0], sx[2], dx_l), (sy[3], sy[5], dy_b)),
        ((sx[3], sx[5], dx_r), (sy[3], sy[5], dy_b)),
    ]:
        put((x0, y0, x1, y1), fx(x0), fy(y0), (x1 - x0) * k, (y1 - y0) * k)

    # horizontal edges: plain | knob | plain
    gx0, gx1 = dx_l(sx[2]), dx_r(sx[3])          # free span in the destination
    kn0, kn1 = KNOB_H
    kw = (kn1 - kn0) * k
    kc = (bx0 + bx1) / 2
    for (y0, y1, fy) in [(sy[0], sy[2], dy_t), (sy[3], sy[5], dy_b)]:
        h = (y1 - y0) * k
        ty = fy(y0)
        put((sx[2], y0, kn0, y1), gx0, ty, kc - kw / 2 - gx0, h)
        put((kn0, y0, kn1, y1), kc - kw / 2, ty, kw, h)
        put((kn1, y0, sx[3], y1), kc + kw / 2, ty, gx1 - (kc + kw / 2), h)

    # vertical edges: plain | knob | plain
    gy0, gy1 = dy_t(sy[2]), dy_b(sy[3])
    kv0, kv1 = KNOB_V
    kh = (kv1 - kv0) * k
    kcy = (by0 + by1) / 2
    for (x0, x1, fx) in [(sx[0], sx[2], dx_l), (sx[3], sx[5], dx_r)]:
        w = (x1 - x0) * k
        tx = fx(x0)
        put((x0, sy[2], x1, kv0), tx, gy0, w, kcy - kh / 2 - gy0)
        put((x0, kv0, x1, kv1), tx, kcy - kh / 2, w, kh)
        put((x0, kv1, x1, sy[3]), tx, kcy + kh / 2, w, gy1 - (kcy + kh / 2))
    return out


def main() -> None:
    k = float(sys.argv[1]) if len(sys.argv) > 1 else 0.6
    sheet = Image.open(SRC).convert('RGBA')
    for name, x0 in [('slot-frame-active', 0), ('slot-frame', 888)]:
        canvas = Image.new('RGBA', (C, C), (0, 0, 0, 0))
        canvas.alpha_composite(sheet.crop((x0, 0, min(sheet.width, x0 + C), C)), (0, 0))
        thin(canvas, k).resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS).save(
            os.path.join(OUT, f'{name}.webp'), lossless=True, method=6
        )
    print(f'thickness x{k}: band ~{round(108 * k)}px of {BODY[2] - BODY[0]} (was 108)')


if __name__ == '__main__':
    main()
