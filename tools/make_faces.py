"""
Roster slot pictures: just the fighter's face (no body), cut from the head
portraits (row 0 of the sheet, already sliced to portrait-N.webp), centred on
the face itself and fitted whole into the slot window.

Usage: python tools/make_faces.py      (all fighters in public/assets/fighters)
Writes public/assets/fighters/<id>/face-N.webp for every portrait-N.webp.
"""
import os
import re

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIGHTERS = os.path.join(ROOT, 'public', 'assets', 'fighters')

#: width / height of the slot window (CharacterSelect.vue .slot-face)
WINDOW_ASPECT = 1.064
#: margin around the head (1.0 = the farther of hair / chin touches the frame)
FIT = 1.06
OUT_HEIGHT = 300


def make_face(path: str, out_path: str) -> None:
    img = Image.open(path).convert('RGBA')
    rgba = np.asarray(img).astype(np.int16)
    alpha = rgba[..., 3] > 128
    rows = np.where(alpha.any(axis=1))[0]
    top, bottom = int(rows[0]), int(rows[-1])
    r, g, b = rgba[..., 0], rgba[..., 1], rgba[..., 2]
    skin = alpha & (r > 150) & (r > g + 15) & (g > b) & (r - b > 40)
    sy, sx = np.where(skin)
    if len(sx) == 0:  # no skin found: fall back to the silhouette centre
        sy, sx = np.where(alpha)
    cx, cy = float(sx.mean()), float(sy.mean())
    half_h = max(cy - top, bottom - cy) * FIT
    h = round(2 * half_h)
    w = round(h * WINDOW_ASPECT)
    x0, y0 = round(cx - w / 2), round(cy - h / 2)
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    box = (max(0, x0), max(0, y0), min(img.width, x0 + w), min(img.height, y0 + h))
    out.alpha_composite(img.crop(box), (box[0] - x0, box[1] - y0))
    out = out.resize((round(OUT_HEIGHT * WINDOW_ASPECT), OUT_HEIGHT), Image.LANCZOS)
    out.save(out_path, quality=92, method=6)


def main() -> None:
    for name in sorted(os.listdir(FIGHTERS)):
        d = os.path.join(FIGHTERS, name)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            m = re.fullmatch(r'portrait-(\d+)\.webp', f)
            if m:
                make_face(os.path.join(d, f), os.path.join(d, f'face-{m.group(1)}.webp'))
                print(f'{name}: face-{m.group(1)}.webp')


if __name__ == '__main__':
    main()
