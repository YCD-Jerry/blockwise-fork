#!/usr/bin/env python3
"""Generates the brand SVGs. Run: python3 brand/tools/build.py  (needs fontTools; font = Caladea Regular, OFL).
Palette is copied from apps/web/src/style.css (--paper --sheet --ink --rule --accent)."""
import os, math
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
P = dict(paper="#f3eee3", sheet="#faf7f0", ink="#1b1a17", rule="#cfc7b4", accent="#1c3aa9")
# dark variant: same roles, accent lifted to stay >= 4.5:1 on the dark ground
D = dict(bg="#15140f", fg="#f3eee3", rule="#4b473d", accent="#8296e6")

def f(x):
    s = ("%.2f" % x).rstrip("0").rstrip(".")
    return s if s != "-0" else "0"

def svg(w, h, body, title, bg=None, desc=""):
    b = f'<rect width="{f(w)}" height="{f(h)}" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f(w)} {f(h)}" width="{f(w)}" height="{f(h)}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{b}{body}</svg>\n')

def wells(cells, x0, y0, pitch, r, fill, empty=None, empty_w=1.2, accent=None, acc_fill=None):
    """cells: list of (col,row,state) state in 'on','off','acc'. Returns svg circles."""
    out = []
    for c, rr, st in cells:
        cx, cy = x0 + pitch * (c + .5), y0 + pitch * (rr + .5)
        if st == "on":
            out.append(f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r)}" fill="{fill}"/>')
        elif st == "acc":
            out.append(f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r)}" fill="{acc_fill}"/>')
        elif empty:
            out.append(f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r - empty_w / 2)}" fill="none" stroke="{empty}" stroke-width="{f(empty_w)}"/>')
    return "".join(out)

def plate_frame(x, y, w, h, stroke, sw=2, rx=7, cut=14):
    # microplate outline with the clipped A1 corner at top-left
    d = (f"M{f(x+cut)} {f(y)}H{f(x+w-rx)}A{rx} {rx} 0 0 1 {f(x+w)} {f(y+rx)}V{f(y+h-rx)}"
         f"A{rx} {rx} 0 0 1 {f(x+w-rx)} {f(y+h)}H{f(x+rx)}A{rx} {rx} 0 0 1 {f(x)} {f(y+h-rx)}V{f(y+cut)}Z")
    return f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round"/>'

# ---------------------------------------------------------------- concept A: letter plate (B)
GLYPH_B = ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."]
def cells_letter(g, acc=None):
    out = []
    for r, row in enumerate(g):
        for c, ch in enumerate(row):
            out.append((c, r, "acc" if acc == (c, r) else ("on" if ch == "#" else "off")))
    return out

def concept_a(t, small=False):
    ink, rule, acc = t["fg"], t["rule"], t["accent"]
    if small:  # 32 grid, no empty wells
        cells = [c for c in cells_letter(GLYPH_B, (3, 3)) if c[2] != "off"]
        return 32, wells(cells, 5.5, 2, 3.0 + 0.0, 1.45, ink, acc_fill=acc) if False else wells(cells, 6, 2, 4, 1.8, ink, acc_fill=acc)
    cells = cells_letter(GLYPH_B, (3, 3))
    pitch, r = 15.0, 6.2
    x0, y0 = 64 - pitch * 2.5, 64 - pitch * 3.5
    return 128, wells(cells, x0, y0, pitch, r, ink, rule, 1.8, acc_fill=acc)

# ---------------------------------------------------------------- concept B: plate on a ruler (N wells, B blocks)
def concept_b(t, small=False):
    ink, rule, acc = t["fg"], t["rule"], t["accent"]
    if small:  # 32 grid = 16 px x2. Well centres sit on half pixels (odd units) so 16 px stays crisp.
        body = ""
        for cx in (5, 11, 21, 27):
            for cy in (5, 11, 17):
                body += f'<circle cx="{cx}" cy="{cy}" r="2.3" fill="{ink}"/>'
        for x in (4, 20):
            body += f'<rect x="{x}" y="24" width="8" height="4" rx="2" fill="{acc}"/>'
        return 32, body
    pitch, r, gap = 9.6, 3.8, 4.8           # 8 columns = 4 blocks of 2
    rows = 5
    W = 8 * pitch + 3 * gap
    pad = 8.5
    fw, fh = W + 2 * pad, rows * pitch + 2 * pad
    fx, fy = 64 - fw / 2, 64 - (fh + 22) / 2
    x0, y0 = fx + pad, fy + pad
    body = plate_frame(fx, fy, fw, fh, ink, 2.2, 7, 11)
    for c in range(8):
        for rr in range(rows):
            cx = x0 + pitch * (c + .5) + (c // 2) * gap
            body += f'<circle cx="{f(cx)}" cy="{f(y0 + pitch*(rr+.5))}" r="{r}" fill="{ink}"/>'
    for k in range(4):
        body += f'<rect x="{f(x0 + k*(2*pitch+gap) + 1)}" y="{f(fy + fh + 9)}" width="{f(2*pitch-2)}" height="6.5" rx="3.25" fill="{acc}"/>'
    return 128, body

# ---------------------------------------------------------------- concept C: 3x3 niche plate, one sealed champion
def concept_c(t, small=False):
    ink, rule, acc = t["fg"], t["rule"], t["accent"]
    off = {(2, 0), (0, 2)}
    if small:
        cells = [(c, r, "acc" if (c, r) == (2, 2) else ("off" if (c, r) in off else "on")) for r in range(3) for c in range(3)]
        pitch, r = 9.2, 3.5
        x0 = 16 - 1.5 * pitch
        return 32, wells([(c, rr, 'on') if st == 'off' else (c, rr, st) for c, rr, st in cells], x0, x0, pitch, r, ink, acc_fill=acc)
    cells = [(c, r, "acc" if (c, r) == (2, 2) else ("off" if (c, r) in off else "on")) for r in range(3) for c in range(3)]
    pitch, r = 31, 11.5
    x0 = 64 - 1.5 * pitch
    body = wells(cells, x0, x0, pitch, r, ink, rule, 2.4, acc_fill=acc)
    cx = x0 + pitch * 2.5
    body += f'<circle cx="{f(cx)}" cy="{f(cx)}" r="{f(r + 6)}" fill="none" stroke="{acc}" stroke-width="2.6"/>'
    return 128, body

def tile(fn, theme, small, rounded=True, size=None):
    t = dict(fg=P["ink"], rule=P["rule"], accent=P["accent"]) if theme == "light" else dict(fg=D["fg"], rule=D["rule"], accent=D["accent"])
    w, body = fn(t, small)
    return w, body

CONCEPTS = {"a": (concept_a, "Letter plate: B spelled in wells"),
            "b": (concept_b, "Plate on a ruler: many wells, four blocks"),
            "c": (concept_c, "Niche plate: 3 x 3 wells, one sealed")}

def full(fn, theme, name, bg_mode):
    w, body = tile(fn, theme, False)
    bg = {"paper": P["paper"], "dark": D["bg"], "none": None}[bg_mode]
    return svg(w, w, body, name, bg)

def fav(fn, theme, name):
    w, body = tile(fn, theme, True)
    bg = P["paper"] if theme == "light" else D["bg"]
    # rounded tile so the icon reads on both light and dark browser chrome
    tilebg = f'<rect width="32" height="32" rx="5" fill="{bg}"/>'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="{name}"><title>{name}</title>{tilebg}{body}</svg>\n')

def mono(fn, name):
    # one colour: everything ink, accent element becomes ink as well (for stamps, fax, single-ink print)
    t = dict(fg=P["ink"], rule=P["ink"], accent=P["ink"])
    w, body = fn(t, False)
    return svg(w, w, body, name)

def write(name, s):
    with open(os.path.join(OUT, name), "w") as fh:
        fh.write(s)

# ---------------------------------------------------------------- wordmark as geometry
FONT = "/usr/share/fonts/truetype/crosextra/Caladea-Regular.ttf"
def outline(word, track=0):
    font = TTFont(FONT)
    gs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font["hmtx"]
    upm = font["head"].unitsPerEm
    x, paths = 0, []
    for ch in word:
        gn = cmap[ord(ch)]
        pen = SVGPathPen(gs, ntos=lambda v: f(v))
        # flip y (font y-up -> svg y-down), 1 unit = 1/upm em
        tp = TransformPen(pen, (1, 0, 0, -1, x, 0))
        gs[gn].draw(tp)
        paths.append(pen.getCommands())
        x += hmtx[gn][0] + track
    return " ".join(paths), x - track, upm, font["OS/2"].sCapHeight, font["OS/2"].sxHeight

def wordmark(word, fill, bg=None, pad=0.25, size=64, track=8):
    d, adv, upm, cap, xh = outline(word, track)
    s = size / upm  # px per unit; size = font size px
    asc, desc = 0.80 * upm, 0.22 * upm
    w = (adv + 2 * pad * upm * 0.5) * s
    h = (asc + desc + 2 * pad * upm * 0.5) * s
    tx, ty = pad * upm * 0.5 * s, (pad * upm * 0.5 + asc) * s
    body = f'<path transform="translate({f(tx)} {f(ty)}) scale({f(s)})" fill="{fill}" d="{d}"/>'
    return w, h, body, ty, s

def wordmark_svg(word, theme):
    fill = P["ink"] if theme == "light" else D["fg"]
    w, h, body, _, _ = wordmark(word, fill)
    return svg(w, h, body, word)

def wordmark_text(word):
    stack = '"Iowan Old Style","Palatino Linotype",Palatino,Charter,"Source Serif Pro",Georgia,"Songti SC","Noto Serif CJK SC",serif'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 96" width="360" height="96" role="img" aria-label="{word}"><title>{word}</title>'
            f'<text x="12" y="66" font-family=\'{stack}\' font-size="64" letter-spacing="0.5" fill="{P["ink"]}">{word}</text></svg>\n')

def lockup(fn, word, theme):
    t = dict(fg=P["ink"], rule=P["rule"], accent=P["accent"]) if theme == "light" else dict(fg=D["fg"], rule=D["rule"], accent=D["accent"])
    w0, mark = fn(t, False)
    fill = t["fg"]
    # mark is 128 box; wordmark cap-height ~ 0.42 of mark height
    ww, wh, wbody, ty, s = wordmark(word, fill, size=68, track=8)
    gap = 6
    W, H = w0 + gap + ww, w0
    ox, oy = w0 + gap, (H - wh) / 2
    body = mark + f'<g transform="translate({f(ox)} {f(oy)})">{wbody}</g>'
    return svg(W, H, body, word, bg=None)

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for k, (fn, desc) in CONCEPTS.items():
        write(f"concept-{k}.svg", full(fn, "light", f"Concept {k.upper()}: {desc}", "paper"))
        write(f"concept-{k}-dark.svg", full(fn, "dark", f"Concept {k.upper()} dark", "dark"))
        write(f"concept-{k}-favicon.svg", fav(fn, "light", f"Concept {k.upper()} favicon"))
    import sys
    final = os.environ.get("FINAL", "b")
    fn = CONCEPTS[final][0]
    write("logo.svg", full(fn, "light", "Blockwise mark", "none"))
    write("logo-paper.svg", full(fn, "light", "Blockwise mark on paper", "paper"))
    write("logo-dark.svg", full(fn, "dark", "Blockwise mark, dark", "dark"))
    write("logo-mono.svg", mono(fn, "Blockwise mark, one ink"))
    write("favicon.svg", fav(fn, "light", "Blockwise favicon"))
    write("favicon-dark.svg", fav(fn, "dark", "Blockwise favicon, dark"))
    for word, suffix in (("Blockwise", ""), ("Assayer", "-assayer")):
        write(f"wordmark{suffix}.svg", wordmark_svg(word, "light"))
        write(f"wordmark{suffix}-dark.svg", svg(*wordmark(word, D["fg"])[:2], wordmark(word, D["fg"])[2], word, bg=D["bg"]))
    write("lockup-assayer.svg", lockup(fn, "Assayer", "light"))
    write("wordmark-text.svg", wordmark_text("Blockwise"))
    write("lockup.svg", lockup(fn, "Blockwise", "light"))
    write("lockup-dark.svg", svg(*(lambda s: (0, 0, "", ""))(0)) if False else lockup(fn, "Blockwise", "dark").replace('role="img"', 'role="img" style="background:%s"' % D["bg"]))
    print("ok", final)
