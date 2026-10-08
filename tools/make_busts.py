"""
Roster "bust" images for the character-select slots: head + shoulders + fists
cut from the fighter's idle frame in the atlas, in the aspect of the slot's
window, so the picture fills the frame from edge to edge (like the mock-up).

Usage: python tools/make_busts.py      (all fighters in public/assets/fighters)
Writes public/assets/fighters/<id>/bust.webp. Run after slice_sprites.py.
"""
import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIGHTERS = os.path.join(ROOT, 'public', 'assets', 'fighters')

#: width / height of the slot window (CharacterSelect.vue .slot-face)
WINDOW_ASPECT = 1.064
SCALE = 2  # output at 2x for crisp slots on high-DPI screens
#: where to look for the neck, as shares of the idle frame's height
NECK_SEARCH = (0.3, 0.62)
#: margin around the head (1.0 = the farther of hair / chin touches the frame)
FIT = 1.04


def neck_row(alpha: np.ndarray) -> int:
    """Row of the neck: the narrowest point of the central silhouette between
    the (big) head and the shoulders."""
    h, w = alpha.shape
    cx = int(np.argmax(alpha[: h // 3].sum(axis=0)))  # densest column of the head
    best_row, best_w = int(h * NECK_SEARCH[1]), w
    for y in range(int(h * NECK_SEARCH[0]), int(h * NECK_SEARCH[1])):
        row = alpha[y]
        if not row[cx]:
            continue
        l = cx
        while l > 0 and row[l - 1]:
            l -= 1
        r = cx
        while r < w - 1 and row[r + 1]:
            r += 1
        if r - l < best_w:
            best_w, best_row = r - l, y
    return best_row


def make_bust(fighter_dir: str) -> None:
    with open(os.path.join(fighter_dir, 'atlas.json'), encoding='utf-8') as fh:
        manifest = json.load(fh)
    atlas = Image.open(os.path.join(fighter_dir, manifest['image'])).convert('RGBA')
    idle = manifest['rows'][0][0]  # row 1 frame 0: neutral fighting stance
    frame = atlas.crop((idle['x'], idle['y'], idle['x'] + idle['w'], idle['y'] + idle['h']))
    # centre on the face itself (skin pixels), not on the hair/ears outline,
    # and size the crop so the whole head still fits around it
    rgba = np.asarray(frame).astype(np.int16)
    alpha = rgba[..., 3] > 128
    head_top = int(np.where(alpha.any(axis=1))[0][0])
    head_bottom = neck_row(alpha)
    r, g, b = rgba[..., 0], rgba[..., 1], rgba[..., 2]
    skin = alpha & (r > 150) & (r > g + 15) & (g > b) & (r - b > 40)
    skin[:head_top] = False
    skin[head_bottom:] = False
    sy, sx = np.where(skin)
    cx, cy = float(sx.mean()), float(sy.mean())
    half_h = max(cy - head_top, head_bottom - cy) * FIT
    h = round(2 * half_h)
    w = round(h * WINDOW_ASPECT)
    x0 = round(cx - w / 2)
    y0 = round(cy - h / 2)
    bust = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    src_box = (max(0, x0), max(0, y0), min(frame.width, x0 + w), min(frame.height, y0 + h))
    bust.alpha_composite(frame.crop(src_box), (src_box[0] - x0, src_box[1] - y0))
    bust = bust.resize((bust.width * SCALE, bust.height * SCALE), Image.LANCZOS)
    bust.save(os.path.join(fighter_dir, 'bust.webp'), quality=92, method=6)
    print(f'{os.path.basename(fighter_dir)}: bust {bust.size}')


def main() -> None:
    for name in sorted(os.listdir(FIGHTERS)):
        d = os.path.join(FIGHTERS, name)
        if os.path.isfile(os.path.join(d, 'atlas.json')):
            make_bust(d)


if __name__ == '__main__':
    main()
