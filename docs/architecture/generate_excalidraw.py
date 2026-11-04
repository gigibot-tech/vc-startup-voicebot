"""Generate architecture.excalidraw (+ SVG preview) for startup_voice.

Usage: python generate_excalidraw.py docs/architecture/architecture.excalidraw

Modules, edges and classes are transcribed from the analysis done with
.bob/skills/dependency-uml-diagram/deps.py and `ast`. When imports change, re-run deps.py
and update PY / JS below. The generator reports any edge that crosses a foreign box.
"""

import json
import random
import sys
from xml.sax.saxutils import escape

random.seed(7)
FS, CW, LH = 14, 8.4, 1.25  # monospace: char width ~ 0.6 * font size
els: list[dict] = []
byid: dict[str, dict] = {}
problems: list[str] = []
_n = [0]


def _base(t, x, y, w, h, **kw):
    _n[0] += 1
    e = dict(id=kw.pop("id", f"e{_n[0]}"), type=t, x=x, y=y, width=w, height=h, angle=0,
             strokeColor="#1e1e1e", backgroundColor="transparent", fillStyle="solid", strokeWidth=2,
             strokeStyle="solid", roughness=0, opacity=100, groupIds=[], frameId=None,
             roundness=None, seed=random.randint(1, 2**31), version=1,
             versionNonce=random.randint(1, 2**31), isDeleted=False, boundElements=[],
             updated=1, link=None, locked=False)
    e.update(kw)
    return e


def text(x, y, s, size=FS, color="#1e1e1e", container=None, align="left"):
    lines = s.split("\n")
    w = max(len(l) for l in lines) * size * 0.6
    h = len(lines) * size * LH
    e = _base("text", x, y, w, h, text=s, originalText=s, fontSize=size, fontFamily=3,
              textAlign=align, verticalAlign="middle" if container else "top",
              containerId=container, lineHeight=LH, autoResize=True, strokeColor=color)
    els.append(e)
    return e


def bw(lines, minw=0):
    return max(max(len(l) for l in lines) * CW + 28, minw)


def box(id, left, y, lines, bg, stroke="#1e1e1e", sw=2, minw=0):
    """Box with left edge `left`, top `y`; text is bound inside and centred."""
    w = bw(lines, minw)
    h = len(lines) * FS * LH + 22
    r = _base("rectangle", left, y, w, h, id=id, backgroundColor=bg, strokeColor=stroke,
              strokeWidth=sw, roundness={"type": 3})
    els.append(r)
    byid[id] = r
    tw = max(len(l) for l in lines) * CW
    t = text(left + (w - tw) / 2, y + 11, "\n".join(lines), container=id, align="center")
    r["boundElements"].append({"type": "text", "id": t["id"]})
    return r


def boxc(id, cx, y, lines, bg, stroke="#1e1e1e", sw=2, minw=0):
    return box(id, cx - bw(lines, minw) / 2, y, lines, bg, stroke, sw, minw)


def cx(i):
    r = byid[i]
    return r["x"] + r["width"] / 2


def _hit(r, c, d):
    vx, vy = d
    tx = (r["width"] / 2) / abs(vx) if vx else 1e9
    ty = (r["height"] / 2) / abs(vy) if vy else 1e9
    t = min(tx, ty)
    return (c[0] + vx * t, c[1] + vy * t)


def edge(a, b, color="#868e96", sw=1, dash=False, start=None, end="arrow", label=None, mode="c", x=None):
    """mode c = centre to centre, v = vertical at x, h = horizontal between facing sides."""
    A, B = byid[a], byid[b]
    ac = (A["x"] + A["width"] / 2, A["y"] + A["height"] / 2)
    bc = (B["x"] + B["width"] / 2, B["y"] + B["height"] / 2)
    if mode == "v":
        down = bc[1] > ac[1]
        p0 = (x, A["y"] + A["height"] if down else A["y"])
        p1 = (x, B["y"] if down else B["y"] + B["height"])
    elif mode == "h":
        y = (max(A["y"], B["y"]) + min(A["y"] + A["height"], B["y"] + B["height"])) / 2
        right = bc[0] > ac[0]
        p0 = (A["x"] + A["width"] if right else A["x"], y)
        p1 = (B["x"] if right else B["x"] + B["width"], y)
    else:
        d = (bc[0] - ac[0], bc[1] - ac[1])
        p0 = _hit(A, ac, d)
        p1 = _hit(B, bc, (-d[0], -d[1]))
    for k in range(1, 200):  # self-check: no foreign box may be crossed
        px = p0[0] + (p1[0] - p0[0]) * k / 200
        py = p0[1] + (p1[1] - p0[1]) * k / 200
        for r in els:
            if r["type"] == "rectangle" and r["id"] not in (a, b) and \
               r["x"] + 2 < px < r["x"] + r["width"] - 2 and r["y"] + 2 < py < r["y"] + r["height"] - 2:
                problems.append(f"{a} -> {b} kreuzt {r['id']}")
                break
        else:
            continue
        break
    e = _base("arrow", p0[0], p0[1], p1[0] - p0[0], p1[1] - p0[1], strokeColor=color, strokeWidth=sw,
              strokeStyle="dashed" if dash else "solid", roundness={"type": 2},
              points=[[0, 0], [p1[0] - p0[0], p1[1] - p0[1]]], lastCommittedPoint=None,
              startBinding={"elementId": a, "focus": 0, "gap": 4},
              endBinding={"elementId": b, "focus": 0, "gap": 4},
              startArrowhead=start, endArrowhead=end, elbowed=False)
    els.append(e)
    A["boundElements"].append({"type": "arrow", "id": e["id"]})
    B["boundElements"].append({"type": "arrow", "id": e["id"]})
    if label:
        text((p0[0] + p1[0]) / 2 + 6, (p0[1] + p1[1]) / 2 - 8, label, size=12, color="#495057")
    return e


RED, GREY, INK = "#e03131", "#adb5bd", "#1e1e1e"
C = dict(web="#ffd8a8", pipe="#a5d8ff", core="#d0bfff", dom="#b2f2bb", io="#ffec99", ext="#e9ecef")
WIDE = 1960

# ───────────────────────── A: backend modules ─────────────────────────
text(40, 20, "A  Backend: Modul-Abhängigkeiten (Pfeil = importiert)   |   rot = längster Pfad (4 Kanten, 2 Gleichstände)", 18)
R0, R1, R2, R3, R4 = 70, 210, 400, 590, 760
box("web", 40, R0, ["web.py   create_app, main   ·   TurnBody, EvaluateBody, TtsBody, VoicePreflightBody"], C["web"], RED, 3, minw=WIDE)
box("interview_config", 40, R1, ["interview_config.py", "InterviewConfig,", "InterviewConfigStore", "load, save, reset"], C["core"])
box("pipeline", 270, R1, ["pipeline.py", "InterviewPipeline", "start_session, process_turn,", "apply_tool_update,", "finalize_session, clear_dossier"], C["pipe"], RED, 3)
box("llm", 690, R1, ["llm.py", "ConfigurableLLM.complete", "extract_json_block()"], C["io"])
box("stt", 1040, R1, ["stt.py", "SttBackend «Protocol»,", "ElevenLabsStt, DeepgramStt,", "SttRouter, SttError,", "probe_tts_fast()"], C["io"])
box("tts", 1320, R1, ["tts.py", "synthesize_mp3,", "default_voice_settings"], C["io"])
box("dossier_pdf", 1567, R1, ["dossier_pdf.py", "_DossierPdf(FPDF)", "render_dossier_pdf"], C["io"])
box("voice_bridge", 1780, R1, ["voice_bridge.py", "personaplex_*, livekit_*", "parse_tool_webhook_body"], C["io"])
boxc("store", 640, R2, ["store.py", "FileSessionStore", "save, load, list_ids,", "delete, list_meta", "evaluate_artifact_file()"], C["core"], RED, 3)
boxc("scoring", 420, R3, ["scoring.py", "evaluate_dimension,", "pick_next_focus,", "evaluate_session"], C["core"], RED, 3)
boxc("dossier_markdown", 1000, R3, ["dossier_markdown.py", "render_dossier_markdown"], C["core"], RED, 3)
box("domain", 40, R4, ["domain.py   (importiert intern nichts)",
                       "ObjectSlotSpec, DimensionState, StepEvaluation, TurnMessage, StepSnapshot, InterviewSession,",
                       "«Protocol» LLM   ·   field_label, empty_fields, dossier_schema_public"], C["dom"], RED, 3, minw=WIDE)


def pe(a, b, hot=False, **kw):
    edge(a, b, RED if hot else GREY, 3 if hot else 1, **kw)


for t in ("interview_config", "llm", "dossier_pdf", "stt", "tts", "voice_bridge"):
    pe("web", t, mode="v", x=cx(t))
pe("web", "pipeline", True, mode="v", x=cx("pipeline"))
pe("web", "store", mode="v", x=640)
pe("web", "dossier_markdown", mode="v", x=980)
pe("web", "domain", mode="v", x=249)
pe("pipeline", "interview_config", mode="h")
pe("pipeline", "llm", mode="h")
pe("pipeline", "store", True)
pe("pipeline", "scoring")
pe("pipeline", "domain", mode="v", x=290)
pe("store", "scoring", True)
pe("store", "dossier_markdown", True)
pe("store", "domain", mode="v", x=640)
pe("scoring", "domain", True, mode="v", x=cx("scoring"))
pe("dossier_markdown", "domain", True, mode="v", x=cx("dossier_markdown"))
for t in ("interview_config", "dossier_pdf", "voice_bridge"):
    pe(t, "domain", mode="v", x=cx(t))

# ───────────────────────── B: class diagram ─────────────────────────
Y0 = 960
text(40, Y0 - 50, "B  Klassen:  ◆ Komposition   → Nutzung   ┄▷ Realisierung (Protocol, strukturell)", 18)
b0, b1, b2 = Y0, Y0 + 190, Y0 + 420
boxc("LLM", 160, b0, ["«Protocol»", "LLM", "+complete()"], C["dom"])
boxc("InterviewPipeline", 560, b0, ["InterviewPipeline", "-llm: LLM", "-store: FileSessionStore", "-config_store: InterviewConfigStore?"], C["pipe"])
boxc("FileSessionStore", 960, b0, ["FileSessionStore", "+save/load/delete", "+list_ids/list_meta"], C["core"])
boxc("SttBackend", 1700, b0, ["«Protocol»", "SttBackend", "+configured/probe/transcribe"], C["io"])
boxc("ConfigurableLLM", 160, b1, ["ConfigurableLLM", "+complete()", "-_ollama(), -_openai()"], C["io"])
boxc("InterviewConfigStore", 480, b1, ["InterviewConfigStore", "+load/save/reset"], C["core"])
boxc("InterviewSession", 960, b1, ["InterviewSession", "id, language, turn_index,", "finalized, spoken_summary", "+create()"], C["dom"])
boxc("StepSnapshot", 1330, b1, ["StepSnapshot", "turn_index, user_input,", "agent_reply"], C["dom"])
boxc("ElevenLabsStt", 1580, b1, ["ElevenLabsStt"], C["io"])
boxc("DeepgramStt", 1820, b1, ["DeepgramStt"], C["io"])
boxc("InterviewConfig", 480, b2, ["InterviewConfig", "reply_system_prompt,", "greeting, slot_questions", "+question_for(), +normalized()"], C["core"])
boxc("DimensionState", 840, b2, ["DimensionState", "slot, fields, summary,", "evidence, missing_or_vague,", "status, updated_at_turn"], C["dom"])
boxc("TurnMessage", 1075, b2, ["TurnMessage", "role, content, ts"], C["dom"])
boxc("StepEvaluation", 1330, b2, ["StepEvaluation", "field_coverage,", "evidence_specificity,", "next_focus_slot, ready_for_closing"], C["dom"])
boxc("SttRouter", 1700, b2, ["SttRouter", "+backends: list[SttBackend]", "+probe(), +transcribe()"], C["io"])

edge("InterviewPipeline", "LLM", mode="h", label="llm")
edge("InterviewPipeline", "FileSessionStore", mode="h", label="store")
edge("InterviewPipeline", "InterviewConfigStore", label="config_store")
edge("InterviewPipeline", "InterviewSession", color=INK, label="mutiert")
edge("FileSessionStore", "InterviewSession", mode="v", x=960, color=INK, label="persistiert")
edge("ConfigurableLLM", "LLM", mode="v", x=160, dash=True, end="triangle_outline", color=INK)
edge("InterviewConfigStore", "InterviewConfig", mode="v", x=480, color=INK)
edge("InterviewSession", "DimensionState", start="diamond", end=None, color=INK, label="objects 5x")
edge("InterviewSession", "TurnMessage", start="diamond", end=None, color=INK, label="messages *")
edge("InterviewSession", "StepEvaluation", start="diamond", end=None, color=INK, label="evaluation")
edge("StepSnapshot", "StepEvaluation", mode="v", x=1330, start="diamond", end=None, color=INK)
edge("StepSnapshot", "DimensionState", start="diamond", end=None, color=INK)
edge("ElevenLabsStt", "SttBackend", dash=True, end="triangle_outline", color=INK)
edge("DeepgramStt", "SttBackend", dash=True, end="triangle_outline", color=INK)
edge("SttRouter", "SttBackend", mode="v", x=1700, start="diamond", end=None, color=INK, label="*")

# ───────────────────────── C: frontend + packages ─────────────────────────
Y1 = 1620
text(40, Y1 - 50, "C  Frontend (ES-Module) und längste Paketketten   |   rot = längste Pfade (2 Kanten, 4 Gleichstände)", 18)
box("dschema", 40, Y1 + 130, ["js/dossier-schema.js"], C["io"])
box("api", 276, Y1 + 130, ["js/api.js"], C["io"], RED, 3)
box("voice", 420, Y1 + 130, ["js/voice.js", "createVoice(deps)"], C["io"], RED, 3)
box("slist", 770, Y1 + 130, ["js/session-list.js"], C["io"], RED, 3)
box("prefs", 989, Y1 + 130, ["js/prefs.js"], C["io"], RED, 3)
boxc("app", 680, Y1, ["app.js", "Einstieg, State, Wiring"], C["web"], RED, 3)
boxc("format", 680, Y1 + 290, ["js/format.js", "esc, fmtTs, clamp*"], C["dom"], RED, 3)
JS_HOT = {("app", "voice"), ("app", "slist"), ("app", "prefs"), ("voice", "api"),
          ("voice", "format"), ("slist", "format"), ("prefs", "format")}
for a, b, kw in [("app", "dschema", {}), ("app", "api", {}), ("app", "voice", {}), ("app", "slist", {}),
                 ("app", "prefs", {}), ("app", "format", dict(mode="v", x=680)), ("voice", "api", dict(mode="h")),
                 ("voice", "format", {}), ("slist", "format", {}), ("prefs", "format", {})]:
    hot = (a, b) in JS_HOT
    edge(a, b, RED if hot else GREY, 3 if hot else 1, **kw)


def chain(prefix, names, y, stroke, sw, per_row=None):
    """Snake layout: row 1 left->right, row 2 right->left under the last box of row 1."""
    per_row = per_row or len(names)
    ids, x = [], 40
    for i, n in enumerate(names[:per_row]):
        w = bw([n])
        box(f"{prefix}{i}", x, y, [n], C["ext"], stroke, sw)
        ids.append(f"{prefix}{i}")
        x += w + 40
    rest = names[per_row:]
    if rest:
        x_right = byid[ids[-1]]["x"] + byid[ids[-1]]["width"]
        for j, n in enumerate(rest):
            w = bw([n])
            box(f"{prefix}{per_row + j}", x_right - w, y + 90, [n], C["ext"], stroke, sw)
            ids.append(f"{prefix}{per_row + j}")
            x_right -= w + 40
    for a, b in zip(ids, ids[1:]):
        same_row = byid[a]["y"] == byid[b]["y"]
        if same_row:
            edge(a, b, stroke, sw, mode="h")
        else:
            edge(a, b, stroke, sw, mode="v", x=byid[b]["x"] + byid[b]["width"] / 2 if byid[b]["width"] < byid[a]["width"] else cx(a))


text(40, Y1 + 440, "uv tree  Kern (ohne Extras): 4 Kanten", 14)
chain("k", ["startup-voice-agent", "elevenlabs", "httpx", "anyio", "idna"], Y1 + 470, RED, 3)
text(40, Y1 + 580, "uv tree  mit optionalem Extra 'livekit': 9 Kanten (nicht Teil der Kern-Laufzeit)", 14)
chain("x", ["startup-voice-agent", "livekit-plugins-nvidia", "livekit-agents", "opentelemetry-exporter-otlp",
            "…-otlp-proto-grpc", "…-otlp-common", "opentelemetry-sdk", "…-semantic-conventions",
            "opentelemetry-api", "typing-extensions"], Y1 + 610, "#f08c00", 2, per_row=5)

out = sys.argv[1]
json.dump({"type": "excalidraw", "version": 2, "source": "generate_excalidraw.py", "elements": els,
           "appState": {"viewBackgroundColor": "#ffffff", "gridSize": None}, "files": {}},
          open(out, "w"), ensure_ascii=False, indent=1)

# SVG preview (same geometry, for a quick visual check without Excalidraw)
W = max(e["x"] + e["width"] for e in els) + 40
H = max(e["y"] + e["height"] for e in els) + 40
s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" viewBox="0 0 {W:.0f} {H:.0f}">'
     '<rect width="100%" height="100%" fill="#fff"/>']


def head(kind, x, y, dx, dy, col):
    import math
    n = math.hypot(dx, dy) or 1
    ux, uy = dx / n, dy / n
    px, py = -uy, ux
    if kind in ("arrow", "triangle_outline"):
        L, Wd = 12, 6
        pts = [(x, y), (x - ux * L + px * Wd, y - uy * L + py * Wd), (x - ux * L - px * Wd, y - uy * L - py * Wd)]
        fill = col if kind == "arrow" else "#fff"
    else:  # diamond
        L, Wd = 14, 6
        pts = [(x, y), (x + ux * L / 2 + px * Wd, y + uy * L / 2 + py * Wd), (x + ux * L, y + uy * L),
               (x + ux * L / 2 - px * Wd, y + uy * L / 2 - py * Wd)]
        fill = col
    return '<polygon points="' + " ".join(f"{a:.1f},{b:.1f}" for a, b in pts) + f'" fill="{fill}" stroke="{col}"/>'


for e in els:
    if e["type"] == "rectangle":
        s.append(f'<rect x="{e["x"]}" y="{e["y"]}" width="{e["width"]}" height="{e["height"]}" rx="12" '
                 f'fill="{e["backgroundColor"]}" stroke="{e["strokeColor"]}" stroke-width="{e["strokeWidth"]}"/>')
for e in els:
    if e["type"] == "arrow":
        dx, dy = e["points"][1]
        x1, y1, x2, y2 = e["x"], e["y"], e["x"] + dx, e["y"] + dy
        da = ' stroke-dasharray="6 5"' if e["strokeStyle"] == "dashed" else ""
        s.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{e["strokeColor"]}" '
                 f'stroke-width="{e["strokeWidth"]}"{da}/>')
        if e["endArrowhead"]:
            s.append(head(e["endArrowhead"], x2, y2, dx, dy, e["strokeColor"]))
        if e["startArrowhead"]:
            s.append(head(e["startArrowhead"], x1, y1, -dx, -dy, e["strokeColor"]))
for e in els:
    if e["type"] == "text":
        for i, l in enumerate(e["text"].split("\n")):
            ax = e["x"] + (e["width"] / 2 if e["textAlign"] == "center" else 0)
            anc = "middle" if e["textAlign"] == "center" else "start"
            s.append(f'<text x="{ax}" y="{e["y"] + (i + 0.8) * e["fontSize"] * LH}" font-family="Menlo,monospace" '
                     f'font-size="{e["fontSize"]}" text-anchor="{anc}" fill="{e["strokeColor"]}" '
                     f'xml:space="preserve">{escape(l)}</text>')
s.append("</svg>")
open(out.replace(".excalidraw", ".preview.svg"), "w").write("\n".join(s))
print(f"{len(els)} Elemente, Canvas {W:.0f}x{H:.0f}")
print("Kanten durch fremde Boxen:", problems or "keine")
