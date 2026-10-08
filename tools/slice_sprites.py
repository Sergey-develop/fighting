"""
Slice the original fighter sprite sheets into a runtime atlas.

The source sheets (figther-*/...png) are 16-17k x 32k px with an opaque #232323
background, which browsers cannot load as a texture. This tool never modifies
them; it writes derived files to public/assets/fighters/<id>/:

    atlas.webp   packed frames with transparent background
    atlas.json   rows -> frames (atlas rect + anchor in frame px)
    portrait-N.webp HUD / select portraits (row 0 of the sheet)

Usage:  python tools/slice_sprites.py                 (all fighters in SOURCES)
        python tools/slice_sprites.py <id> <sheet.png>  (one new fighter)
        python tools/slice_sprites.py --preview       (also writes preview sheets)

Sheets are expected in the same layout as the existing ones: rows of frames
on a flat #232323 background, row 0 = portraits, row 1 starts with idle.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage, signal

sys.path.insert(0, os.path.dirname(__file__))
from detect_frames import detect  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'assets', 'fighters')

# fighter id -> source sheet (relative to project root)
SOURCES = {
    'developer': 'figther-1/Разработчик.png',
    'producer': 'figther-2/Продюсер - Борис Альхимович.png',
}

SCALE = 0.25           # runtime sprite scale for frames
PORTRAIT_SCALE = 0.5   # portraits are shown bigger in menus
PAD = 24               # full-res padding around detected boxes
ATLAS_MAX_W = 4096
BG = 35.0


def background_mask(rgb: np.ndarray) -> np.ndarray:
    """
    Pixels that are the sheet background (#232323) or panel borders (#2a2a2a).
    Kept deliberately strict: dark grey clothing (e.g. the developer's
    trousers, ~#3f3b3f / #262126) must never be treated as background.
    """
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    neutral = (mx - mn) <= 2
    bg = (np.abs(rgb - BG) <= 3).all(axis=2)
    border = (np.abs(rgb - 42.0) <= 2).all(axis=2)
    return neutral & (bg | border)


def cut_frame(sheet: Image.Image, box, scale: float) -> Image.Image:
    x0, y0, x1, y1 = box
    crop = sheet.crop((x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD)).convert('RGB')
    w = max(1, round(crop.width * scale))
    h = max(1, round(crop.height * scale))
    small = np.asarray(crop.resize((w, h), Image.LANCZOS)).astype(np.float32)

    bg = background_mask(small)
    # background = bg-coloured regions connected to the border, plus large
    # enclosed bg-coloured holes (e.g. between arm and torso)
    labels, n = ndimage.label(bg)
    border = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])))
    border.discard(0)
    sizes = ndimage.sum(bg, labels, range(n + 1))
    remove = np.zeros(n + 1, dtype=bool)
    for lab in range(1, n + 1):
        # enclosed holes: only large ones (gaps between arm and body), so stray
        # background-coloured pixels inside the art are never punched out
        if lab in border or sizes[lab] > 2400 * scale * scale:
            remove[lab] = True
    transparent = remove[labels]

    # soft edge: pixels next to the removed background get alpha from their
    # distance to the bg colour and are un-blended from it (keeps glows clean)
    near = ndimage.binary_dilation(transparent, iterations=2) & ~transparent
    diff = np.abs(small - BG).max(axis=2)
    alpha = np.where(transparent, 0.0, 1.0)
    soft = np.clip(diff / 60.0, 0.0, 1.0)
    alpha = np.where(near, soft, alpha)
    a = alpha[..., None]
    rgb = np.where(a > 0.01, (small - (1 - a) * BG) / np.maximum(a, 0.01), 0)
    rgba = np.dstack([np.clip(rgb, 0, 255), alpha * 255]).astype(np.uint8)
    img = Image.fromarray(rgba, 'RGBA')
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def grey(img: Image.Image) -> np.ndarray:
    arr = np.asarray(img).astype(np.float32)
    g = arr[..., :3].mean(axis=2)
    return g * (arr[..., 3] / 255.0)


def match_head(template: np.ndarray, frame: np.ndarray):
    """Normalised cross-correlation; returns (score, x, y) of best match."""
    th, tw = template.shape
    if frame.shape[0] < th or frame.shape[1] < tw:
        return -1.0, 0, 0
    t = template - template.mean()
    tn = np.sqrt((t * t).sum())
    corr = signal.fftconvolve(frame, t[::-1, ::-1], mode='valid')
    ones = np.ones_like(template)
    s1 = signal.fftconvolve(frame, ones, mode='valid')
    s2 = signal.fftconvolve(frame * frame, ones, mode='valid')
    var = s2 - s1 * s1 / template.size
    # flat / transparent windows have ~zero variance and would explode the
    # score — require at least a fraction of the template's own contrast
    min_var = 0.05 * (t * t).sum()
    ncc = np.where(var > min_var, corr / (np.sqrt(np.maximum(var, 1e-6)) * tn), -1.0)
    ncc = np.clip(ncc, -1.0, 1.0)
    y, x = np.unravel_index(np.argmax(ncc), ncc.shape)
    return float(ncc[y, x]), int(x), int(y)


def pack(frames):
    """Simple shelf packer. frames: list of PIL images -> (w, h, positions)."""
    order = sorted(range(len(frames)), key=lambda i: -frames[i].height)
    pos = [None] * len(frames)
    x = y = shelf = 0
    width = 0
    for i in order:
        f = frames[i]
        if x + f.width > ATLAS_MAX_W:
            x = 0
            y += shelf + 2
            shelf = 0
        pos[i] = (x, y)
        x += f.width + 2
        width = max(width, x)
        shelf = max(shelf, f.height)
    return width, y + shelf, pos


def process(fid: str, src: str, preview: bool):
    path = os.path.join(ROOT, src)
    print(f'[{fid}] detecting frames in {src}')
    rows = detect(path)
    sheet = Image.open(path)
    out_dir = os.path.join(OUT, fid)
    os.makedirs(out_dir, exist_ok=True)

    # row 0: portraits
    portraits = []
    for i, box in enumerate(rows[0]['frames']):
        img = cut_frame(sheet, box, PORTRAIT_SCALE)
        name = f'portrait-{i}.webp'
        img.save(os.path.join(out_dir, name), quality=90, method=6)
        portraits.append(name)

    frames = []   # (row, index, image)
    for r, row in enumerate(rows[1:], start=1):
        for i, box in enumerate(row['frames']):
            frames.append((r, i, cut_frame(sheet, box, SCALE)))
            print(f'  row {r} frame {i}: {frames[-1][2].size}')

    # head template from the first idle frame (row 1 frame 0): top 40%
    ref = frames[0][2]
    ref_g = grey(ref)
    th = int(ref.height * 0.4)
    template = ref_g[:th]
    ref_anchor_x = ref.width / 2.0
    ref_head_dx = ref_anchor_x  # template's left edge sits at x=0 in ref

    meta_rows = {}
    for r, i, img in frames:
        score, mx, my = match_head(template, grey(img))
        alpha = np.asarray(img)[..., 3]
        cols = np.where(alpha.max(axis=0) > 128)[0]
        ay = float(img.height)
        if score > 0.55:
            ax = mx + ref_head_dx
            body = True
            # effects that reach below the feet (e.g. a money spray) would
            # otherwise lift the fighter: put the feet where the head says
            feet = my + ref.height
            if img.height > feet + 60:
                print(f'  row {r} frame {i}: feet moved {img.height} -> {feet}')
                ay = float(feet)
        else:
            ax = (cols[0] + cols[-1]) / 2.0 if len(cols) else img.width / 2.0
            body = False
        meta_rows.setdefault(r, []).append({
            'w': img.width, 'h': img.height,
            'ax': round(float(ax), 1), 'ay': round(ay, 1),
            'body': body, 'score': round(score, 3),
        })

    aw, ah, pos = pack([f[2] for f in frames])
    atlas = Image.new('RGBA', (aw, ah), (0, 0, 0, 0))
    k = 0
    for (r, i, img), (x, y) in zip(frames, pos):
        atlas.paste(img, (x, y))
        meta_rows[r][i]['x'] = x
        meta_rows[r][i]['y'] = y
        k += 1
    atlas.save(os.path.join(out_dir, 'atlas.webp'), quality=90, method=6)
    manifest = {
        'source': src,
        'image': 'atlas.webp',
        'scale': SCALE,
        'portraitScale': PORTRAIT_SCALE,
        'portraits': portraits,
        'rows': [meta_rows[r] for r in sorted(meta_rows)],
    }
    with open(os.path.join(out_dir, 'atlas.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=1)
    print(f'[{fid}] atlas {aw}x{ah}, {k} frames, {len(portraits)} portraits')

    if preview:
        write_preview(fid, frames, meta_rows)


def write_preview(fid, frames, meta_rows):
    rows = {}
    for r, i, img in frames:
        rows.setdefault(r, []).append((i, img))
    cell_h = 420
    width = max(sum(max(img.width, 100) + 20 for _, img in v) for v in rows.values()) + 80
    canvas = Image.new('RGB', (width, cell_h * len(rows)), (60, 60, 70))
    d = ImageDraw.Draw(canvas)
    for ri, r in enumerate(sorted(rows)):
        x = 60
        base = ri * cell_h + cell_h - 20
        d.text((5, base - 200), f'r{r}', fill=(255, 255, 0))
        d.line([(0, base), (width, base)], fill=(90, 90, 110))
        for i, img in rows[r]:
            m = meta_rows[r][i]
            ox = x + 120 - int(m['ax'])
            canvas.paste(img, (ox, base - img.height), img)
            col = (0, 255, 0) if m['body'] else (255, 60, 60)
            d.line([(x + 120, base - 400), (x + 120, base)], fill=col)
            d.text((x + 100, base + 2), f'{i}:{m["score"]}', fill=col)
            x += max(img.width, 240) + 20
    canvas.save(os.path.join(os.environ.get('PREVIEW_DIR', OUT), f'preview-{fid}.jpg'), quality=80)


if __name__ == '__main__':
    preview = '--preview' in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) == 2:
        # new fighter: python tools/slice_sprites.py <id> <path/to/sheet.png>
        process(args[0], args[1], preview)
    elif len(args) == 0:
        for fid, src in SOURCES.items():
            process(fid, src, preview)
    else:
        sys.exit('usage: slice_sprites.py [<fighter-id> <sheet.png>] [--preview]')
