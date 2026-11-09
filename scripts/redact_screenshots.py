"""Redact privacy regions from the README screenshots.

The three screenshots were taken from a real DSH window, which exposes:
  - the left sidebar with the user's real session titles and workspace name,
  - the bottom-left user chip (avatar + display name),
  - the session title in the conversation header.

Those are blurred (heavy Gaussian + slight darken) while the plugin UI and the
chat content stay sharp. Regions are defined as ratios so the same script works
if a screenshot is resized.
"""
from PIL import Image, ImageFilter, ImageEnhance
import os
import sys

# (x1, y1, x2, y2) as fractions of width/height
REGIONS = [
    (0.000, 0.000, 0.215, 1.000),   # left sidebar: session list + workspace name
    (0.000, 0.900, 0.190, 1.000),   # bottom-left user chip (avatar + name)
    (0.215, 0.025, 0.520, 0.120),   # header: session title
]

DOCS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs')
DEFAULT_FILES = ['hero.png', 'scroll-to-match.png', 'nested-scroll.png']


def redact(path: str) -> None:
    im = Image.open(path).convert('RGB')
    w, h = im.size
    for (fx1, fy1, fx2, fy2) in REGIONS:
        box = (
            max(0, min(w - 1, int(fx1 * w))),
            max(0, min(h - 1, int(fy1 * h))),
            max(0, min(w, int(fx2 * w))),
            max(0, min(h, int(fy2 * h))),
        )
        if box[2] - box[0] < 2 or box[3] - box[1] < 2:
            continue
        region = im.crop(box)
        # Big radius so no text survives; then darken a little so it reads as a
        # deliberate redaction rather than a broken image.
        blurred = region.filter(ImageFilter.GaussianBlur(radius=max(12, min(w, h) // 40)))
        blurred = ImageEnhance.Brightness(blurred).enhance(0.72)
        im.paste(blurred, box)
    im.save(path, 'PNG', optimize=True)
    print(f'redacted {os.path.basename(path)} {im.size}')


def main() -> int:
    # Optional positional args: which screenshots to redact (default: all).
    files = sys.argv[1:] or DEFAULT_FILES
    for name in files:
        path = os.path.join(DOCS, name)
        if not os.path.exists(path):
            print(f'missing {path}', file=sys.stderr)
            return 1
        redact(path)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
