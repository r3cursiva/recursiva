# A Claude Design TUI artboard (.dc.html, cells of 9x18 px) → its cells as runs of one style, [text, fg, bg, attrs] per run,
# one list of runs per row: python3 grid.py TuiHome.dc.html json > home.json. A wide character's second cell is U+E000.
import re, sys, json, html
from html.parser import HTMLParser
BOX = {"h": "─", "v": "│", "tl": "╭", "tr": "╮", "bl": "╰", "br": "╯"}
class P(HTMLParser):
    def __init__(s):
        super().__init__(convert_charrefs=True); s.rows=[]; s.row=None; s.span=None; s.depth=0; s.in_tui=False; s.tdepth=0; s.wide=False; s.boxk=None; s.boxw=0; s.cellbuf=None
    def handle_starttag(s, tag, a):
        a=dict(a); cls=(a.get("class") or "").split()
        if tag=="div" and "tui" in cls and not s.in_tui: s.in_tui=True; s.tdepth=0
        if not s.in_tui: return
        if tag=="div": s.tdepth+=1
        if tag=="div" and cls==["r"]: s.row=[]; s.rows.append(s.row)
        elif tag=="span" and s.row is not None and s.span is None:
            fg=next((c[2:] for c in cls if c.startswith("f-")),None); bg=next((c[2:] for c in cls if c.startswith("b-")),None)
            at="".join(c for c in cls if c in("B","D","U")); w=int(re.search(r"width:\s*(\d+)px",a.get("style","")).group(1))//9
            s.span={"fg":fg,"bg":bg,"at":at,"w":w,"cells":[]}
        elif tag=="i" and s.span is not None: s.wide="w" in cls; s.cellbuf=""
        elif tag=="b" and s.span is not None:
            k=next((c for c in cls if c in BOX),None); m=re.search(r"width:\s*(\d+)px",a.get("style",""))
            n=int(m.group(1))//9 if m else 1
            s.span["cells"].extend([BOX.get(k,"?")]*n)
    def handle_endtag(s, tag):
        if not s.in_tui: return
        if tag=="i" and s.cellbuf is not None:
            s.span["cells"].append(s.cellbuf);
            if s.wide: s.span["cells"].append("\ue000")
            s.cellbuf=None; s.wide=False
        elif tag=="span" and s.span is not None:
            sp=s.span; cells=sp["cells"][:sp["w"]]+[" "]*max(0,sp["w"]-len(sp["cells"]))
            s.row.extend([[c,sp["fg"],sp["bg"],sp["at"]] for c in cells]); s.span=None
        elif tag=="div":
            s.tdepth-=1
            if s.tdepth==0: s.in_tui=False
    def handle_data(s, d):
        if s.span is None: return
        if s.cellbuf is not None: s.cellbuf+=d; return
        s.span["cells"].extend(list(d.replace("\n","")))
p=P(); p.feed(open(sys.argv[1]).read())
rows=p.rows
if sys.argv[2:3]==["json"]:
    out=[]
    for r in rows:
        runs=[]
        for ch,fg,bg,at in r:
            if runs and runs[-1][1:]==[fg,bg,at]: runs[-1][0]+=ch
            else: runs.append([ch,fg,bg,at])
        out.append(runs)
    print(json.dumps(out,ensure_ascii=False))
else:
    for r in rows: print("".join(c[0] for c in r).rstrip())
