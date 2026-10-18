"""Génère l'image d'illustration d'un article du blog (1200 x 630, JPEG).

Usage : python3 _outils/image-article.py <slug> "<kicker>" "<titre>" "<entreprise fictive>"
Sortie : blog/img/<slug>.jpg
Dossier préfixé « _ » : non publié par GitHub Pages (Jekyll).
"""
import sys, pathlib, urllib.parse, io
from playwright.sync_api import sync_playwright
from PIL import Image

root = pathlib.Path(__file__).resolve().parent.parent
slug, kicker, title, company = sys.argv[1:5]
tpl = (root / "_outils/image-article.html").as_uri()
q = urllib.parse.urlencode({"kicker": kicker, "title": title, "company": company})
out = root / "blog/img" / f"{slug}.jpg"
out.parent.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1200, "height": 630})
    pg.goto(f"{tpl}?{q}")
    pg.wait_for_timeout(300)
    png = pg.screenshot()
    b.close()
Image.open(io.BytesIO(png)).convert("RGB").save(out, "JPEG", quality=85, optimize=True, progressive=True)
print(out, out.stat().st_size)
