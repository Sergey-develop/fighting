"""Detect sprite frames in a source sheet (debug helper). Prints JSON of rows -> frame boxes in full-res px."""
import sys, json
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
R = 8

def fg_mask(im):
    px = im.load(); w, h = im.size
    m = [[False]*w for _ in range(h)]
    for y in range(h):
        row = m[y]
        for x in range(w):
            r, g, b = px[x, y][:3]
            # background 35, panel borders ~42; anything off-grey or far from it is content
            chroma = max(r, g, b) - min(r, g, b)
            lum = (r + g + b) / 3
            row[x] = not (chroma < 8 and 20 <= lum <= 62)
    return m

def runs(flags, min_gap):
    out = []; s = None; gap = 0
    for i, f in enumerate(flags):
        if f:
            if s is None: s = i
            gap = 0; e = i
        elif s is not None:
            gap += 1
            if gap >= min_gap: out.append((s, e+1)); s = None
    if s is not None: out.append((s, e+1))
    return out

def detect(path):
    im = Image.open(path).convert('RGB').reduce(R)
    m = fg_mask(im); w, h = im.size
    rows = runs([any(r) for r in m], 6)
    res = []
    for (y0, y1) in rows:
        if y1 - y0 < 8: continue
        cols = [any(m[y][x] for y in range(y0, y1)) for x in range(w)]
        frames = []
        for (x0, x1) in runs(cols, 4):
            ys = [y for y in range(y0, y1) if any(m[y][x0:x1])]
            if (x1 - x0) < 8 or len(ys) < 8: continue
            frames.append([x0*R, ys[0]*R, x1*R, (ys[-1]+1)*R])
        res.append({'y': [y0*R, y1*R], 'frames': frames})
    return res

if __name__ == '__main__':
    print(json.dumps(detect(sys.argv[1])))
