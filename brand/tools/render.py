#!/usr/bin/env python3
"""Rasterizes brand SVGs with Playwright Chromium and builds the contact sheet. Run after build.py."""
import os, sys, asyncio
from playwright.sync_api import sync_playwright
B = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
FINAL = os.environ.get("FINAL", "b")

def rd(n): return open(os.path.join(B, n)).read()

def shot(page, svgname, out, px, bg=None):
    s = rd(svgname)
    page.set_viewport_size({"width": px, "height": px})
    page.set_content(f'<html><body style="margin:0;background:{bg or "transparent"}"><img src="data:image/svg+xml;base64,{__import__("base64").b64encode(s.encode()).decode()}" width="{px}" height="{px}" style="display:block"></body></html>')
    page.screenshot(path=os.path.join(B, out), omit_background=(bg is None))

def tile_html(svgname, px, bg):
    import base64
    d = base64.b64encode(rd(svgname).encode()).decode()
    return f'<img src="data:image/svg+xml;base64,{d}" width="{px}" height="{px}" style="display:block">'

def png_b64(page, svgname, px):
    import base64
    s = rd(svgname)
    page.set_viewport_size({"width": px, "height": px})
    page.set_content(f'<html><body style="margin:0"><img src="data:image/svg+xml;base64,{base64.b64encode(s.encode()).decode()}" width="{px}" height="{px}" style="display:block"></body></html>')
    return base64.b64encode(page.screenshot()).decode()

def sheet(page):
    rows = []
    for k in "abc":
        light, dark = f"concept-{k}.svg", f"concept-{k}-dark.svg"
        fl, fd = f"concept-{k}-favicon.svg", None
        star = " (final)" if k == FINAL else ""
        rows.append(f'''<section><h2>Concept {k.upper()}{star}</h2><div class="r">
          <div class="t l">{tile_html(light,260,"")}</div>
          <div class="t d">{tile_html(dark,260,"")}</div>
          <div class="sm"><div class="z">{tile_html(fl,32,"")}<i>32</i>{tile_html(fl,16,"")}<i>16</i></div>
          <div class="zz"><div style="display:flex;gap:8px"><img class=px width=128 height=128 src="data:image/png;base64,{png_b64(page, fl, 16)}"><img width=128 height=128 src="data:image/svg+xml;base64,{__import__("base64").b64encode(rd(fl).encode()).decode()}"></div><i>real 16 px raster enlarged 8x (left), vector (right)</i></div></div>
        </div></section>''')
    html = f'''<html><head><style>
    body{{margin:0;padding:24px;background:#e9e3d3;font:13px system-ui,sans-serif;color:#1b1a17;width:1180px}}
    h2{{font:600 16px Georgia,serif;margin:14px 0 8px}} .r{{display:flex;gap:20px;align-items:flex-start}}
    .t{{padding:20px;border-radius:4px}} .l{{background:#f3eee3}} .d{{background:#15140f}}
    .sm{{display:flex;flex-direction:column;gap:12px;align-items:flex-start}} .z{{display:flex;gap:8px;align-items:center;background:#f3eee3;padding:10px}}
    .z i,.zz i{{font-style:normal;font-size:11px;color:#5b574d}} .zz{{display:flex;flex-direction:column;gap:4px}}
    img.px{{image-rendering:pixelated}}
    </style></head><body>{"".join(rows)}</body></html>'''
    page.set_viewport_size({"width": 1230, "height": 1000})
    page.set_content(html)
    page.screenshot(path=os.path.join(B, "sheet.png"), full_page=True)

def finalsheet(page):
    # final: all variants at real sizes
    import base64
    def im(n, w=None, h=None, style=""):
        d = base64.b64encode(rd(n).encode()).decode()
        a = (f'width="{w}" ' if w else "") + (f'height="{h}" ' if h else "")
        return f'<img src="data:image/svg+xml;base64,{d}" {a} style="display:block;{style}">'
    html = f'''<html><head><style>body{{margin:0;padding:24px;background:#e9e3d3;font:12px system-ui;width:1380px}}
    .g{{display:flex;gap:16px;margin-bottom:16px;align-items:center}} .p{{padding:18px;border-radius:4px}}
    </style></head><body>
    <div class="g"><div class="p" style="background:#f3eee3">{im("logo.svg",220,220)}</div><div class="p" style="background:#faf7f0">{im("logo-mono.svg",220,220)}</div>
      <div class="p" style="background:#15140f">{im("logo-dark.svg",220,220)}</div>
      <div class="p" style="background:#f3eee3">{im("lockup.svg",None,120)}</div></div>
    <div class="g"><div class="p" style="background:#15140f">{im("lockup-dark.svg",None,120)}</div><div class="p" style="background:#f3eee3">{im("wordmark.svg",None,70)}</div><div class="p" style="background:#f3eee3">{im("wordmark-assayer.svg",None,70)}</div><div class="p" style="background:#f3eee3">{im("wordmark-text.svg",None,70)}</div></div>
    <div class="g"><div class="p" style="background:#f3eee3">{im("favicon.svg",16,16)}</div><div class="p" style="background:#f3eee3">{im("favicon.svg",32,32)}</div><div class="p" style="background:#15140f">{im("favicon-dark.svg",16,16)}</div><div class="p" style="background:#f3eee3">{im("favicon.svg",96,96)}</div>
    <div class="p" style="background:#c9c4b6;display:flex;gap:6px;align-items:center;font:12px system-ui;color:#222"><span style="background:#fff;border-radius:6px 6px 0 0;padding:6px 10px;display:flex;gap:6px;align-items:center">{im("favicon.svg",16,16)} Blockwise</span></div></div>
    </body></html>'''
    page.set_viewport_size({"width": 1420, "height": 600})
    page.set_content(html)
    page.screenshot(path=os.path.join(B, "sheet-final.png"), full_page=True)

with sync_playwright() as p:
    br = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
    page = br.new_page(device_scale_factor=1)
    shot(page, "logo-paper.svg", "logo-1024.png", 1024)
    shot(page, "logo.svg", "logo-1024-transparent.png", 1024)
    shot(page, "favicon.svg", "favicon-32.png", 32)
    shot(page, "favicon.svg", "favicon-16.png", 16)
    sheet(page); finalsheet(page)
    br.close()
print("rendered")
