#!/usr/bin/env python3

import sys
from pathlib import Path

import fitz
from PIL import Image


SCALE = 2.0
RESOLUTION = 144.0


def main() -> int:
  if len(sys.argv) != 3:
    raise SystemExit("usage: rasterize-pdf.py INPUT_PDF OUTPUT_PDF")

  input_path = Path(sys.argv[1]).resolve()
  output_path = Path(sys.argv[2]).resolve()
  output_path.parent.mkdir(parents=True, exist_ok=True)

  document = fitz.open(input_path)
  images = []

  try:
    for page_index in range(document.page_count):
      page = document.load_page(page_index)
      pixmap = page.get_pixmap(matrix=fitz.Matrix(SCALE, SCALE), alpha=False)
      image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
      images.append(image)

    if not images:
      raise RuntimeError("input PDF has no pages")

    first_image, remaining_images = images[0], images[1:]
    first_image.save(
      output_path,
      "PDF",
      save_all=True,
      append_images=remaining_images,
      resolution=RESOLUTION,
    )
  finally:
    document.close()
    for image in images:
      image.close()

  return 0


if __name__ == "__main__":
  raise SystemExit(main())
