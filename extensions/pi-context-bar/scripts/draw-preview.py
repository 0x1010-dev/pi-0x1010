#!/usr/bin/env python3
"""Draw pi-context-bar preview frames to a PNG.

Reads JSON cell frames on stdin (emitted by render-preview.ts):
  {"frames": [[[{"t": "─", "c": "success", "b": false, "d": false}], ...], ...]}

Writes the PNG to argv[1]. Uses Noto Sans Mono (Regular/Bold); Tokyo Night
palette. No third-party deps beyond PIL.
"""

import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

BG = (26, 27, 38)  # #1a1b26
PALETTE = {
	"text": (192, 202, 245),
	"dim": (86, 95, 137),
	"border": (86, 95, 137),
	"muted": (120, 124, 153),
	"accent": (122, 162, 247),
	"thinkingHigh": (187, 154, 247),
	"success": (158, 206, 106),
	"warning": (224, 175, 104),
	"error": (247, 118, 142),
}
FONT_PATHS = [
	"/usr/share/fonts/noto/NotoSansMono-Regular.ttf",
	"/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
]
FONT_BOLD_PATHS = [
	"/usr/share/fonts/noto/NotoSansMono-Bold.ttf",
	"/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
]
SIZE = 26
PAD = 28
GAP_LINES = 2
DIM_BLEND = 0.45  # SGR 2 approximation: mix toward the background


def pick(paths):
	for p in paths:
		if os.path.exists(p):
			return p
	raise SystemExit("no monospace font found")


def main():
	data = json.load(sys.stdin)
	frames = data["frames"]
	font = ImageFont.truetype(pick(FONT_PATHS), SIZE)
	font_bold = ImageFont.truetype(pick(FONT_BOLD_PATHS), SIZE)
	adv = font.getlength("M")
	line_h = int(SIZE * 1.45)

	rows_total = sum(len(f) for f in frames) + GAP_LINES * (len(frames) - 1)
	max_cols = max(sum(len(c["t"]) for c in row) for f in frames for row in f)

	img = Image.new("RGB", (int(max_cols * adv) + 2 * PAD, int(rows_total * line_h) + 2 * PAD), BG)
	d = ImageDraw.Draw(img)

	def color_for(cell):
		c = PALETTE.get(cell["c"], PALETTE["text"])
		if cell.get("d"):
			c = tuple(int(a + (b - a) * DIM_BLEND) for a, b in zip(c, BG))
		return c

	y = PAD
	for fi, frame in enumerate(frames):
		if fi:
			y += GAP_LINES * line_h
		for row in frame:
			x = PAD
			for cell in row:
				d.text((x, y), cell["t"], font=font_bold if cell.get("b") else font, fill=color_for(cell))
				x += adv * len(cell["t"])
			y += line_h

	out = sys.argv[1]
	img.save(out)
	print(f"{out} {img.size[0]}x{img.size[1]}")


if __name__ == "__main__":
	main()
