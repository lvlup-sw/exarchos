#!/usr/bin/env python3
"""Generate the #1675 gate-catch-rate figure SVG from the committed CSV.

One figure, two panels, mirroring the #1670 / bifrost benchmark charting standard
(`docs/evals/data/2026-07-09/generate_charts.py`):

    chart-gate-catch-rate.svg
        Panel A — per-gate true-positive catch rate (on seeded defects) and
                  false-positive rate (on matched controls).
        Panel B — per-gate measured cost: mean gate-result payload tokens, with
                  the mean wall-clock ms annotated above each bar.

Style note (deliberate): pure-Python-stdlib SVG, NOT matplotlib — hand-written SVG
is byte-for-byte deterministic (matplotlib embeds a nondeterministic <dc:date> and
clip-path ids) and needs no third-party install, exactly what DR-3 asks for: a chart
that regenerates deterministically from committed data with no network. The wall-clock
ms is a machine-dependent snapshot baked into the committed CSV, so this script
reproduces IDENTICAL bytes from that CSV on every run (it never re-drives the gates).

    python3 docs/evals/data/2026-07-10/generate_charts.py

GitHub palette + transparent background, so the SVG sits correctly in both light and
dark GitHub themes.
"""

import csv
from pathlib import Path

HERE = Path(__file__).parent
CSV = HERE / "gate-catch-rate.csv"

# ── GitHub palette (theme-agnostic; the gray FG reads on light and dark) ──────
FG = "#8b949e"
BLUE = "#58a6ff"
ORANGE = "#f0883e"
GREEN = "#3fb950"
RED = "#f85149"
GRAY = "#6e7681"
FONT = "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"

# Fixed gate order (matches the corpus loader's mechanical-class order).
GATES = [
    ("check_test_adequacy", "test-adeq"),
    ("check_contract_drift", "contract"),
    ("check_mock_boundary", "mock-bnd"),
    ("check_static_analysis", "static"),
    ("check_integration_suite", "integ"),
]


# ── SVG helpers (mirror the #1670 generator) ──────────────────────────────────
def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def svg_open(w, h, title):
    return [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
        f'font-family="{FONT}" role="img" aria-label="{_esc(title)}">'
    ]


def text(x, y, s, size=12, anchor="middle", fill=FG, weight="normal"):
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" text-anchor="{anchor}" '
        f'fill="{fill}" font-weight="{weight}">{_esc(s)}</text>'
    )


def vlabel(lines, x, ycenter, s, size=12):
    lines.append(
        f'<text x="{x:.1f}" y="{ycenter:.1f}" font-size="{size}" text-anchor="middle" '
        f'fill="{FG}" transform="rotate(-90 {x:.1f} {ycenter:.1f})">{_esc(s)}</text>'
    )


def rect(x, y, w, h, fill, rx=2, opacity=1.0):
    op = f' opacity="{opacity}"' if opacity != 1.0 else ""
    return f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx}" fill="{fill}"{op}/>'


def line(x1, y1, x2, y2, stroke=FG, width=1.0, dash=None):
    da = f' stroke-dasharray="{dash}"' if dash else ""
    return (
        f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
        f'stroke="{stroke}" stroke-width="{width}"{da}/>'
    )


def _legend_width(entries):
    return sum(18 + 8 + len(label) * 7.0 for label, _ in entries)


def legend_row(lines, x, y, entries):
    cx = x
    for label, color in entries:
        lines.append(rect(cx, y - 9, 12, 12, color))
        lines.append(text(cx + 18, y + 1, label, size=12, anchor="start"))
        cx += 18 + 8 + len(label) * 7.0


def legend_centered(lines, cx, y, entries):
    legend_row(lines, cx - _legend_width(entries) / 2, y, entries)


def save(lines, name):
    lines.append("</svg>")
    (HERE / name).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  wrote {name}")


def y_axis(lines, x, y0, y1, vmax, ticks, fmt=lambda v: f"{v:g}"):
    lines.append(line(x, y0, x, y1, stroke=FG, width=1.2))
    for t in ticks:
        yy = y0 - (t / vmax) * (y0 - y1)
        lines.append(line(x - 4, yy, x, yy, stroke=FG, width=1.0))
        lines.append(text(x - 8, yy + 4, fmt(t), size=11, anchor="end"))


def gridline(lines, x0, x1, y, dash="2 5"):
    lines.append(line(x0, y, x1, y, stroke=FG, width=0.5, dash=dash))


# ── data loading ──────────────────────────────────────────────────────────────
def _rows(path):
    with open(path, encoding="utf-8") as f:
        # Skip provenance `#`-comment header lines; DictReader reads the rest.
        data_lines = [ln for ln in f if not ln.startswith("#")]
    return list(csv.DictReader(data_lines))


def load():
    rows = _rows(CSV)
    out = {}
    for gate, _label in GATES:
        cells = [r for r in rows if r["gate"] == gate]
        defects = [r for r in cells if r["kind"] == "defect"]
        controls = [r for r in cells if r["kind"] == "control"]
        concl_def = [r for r in defects if r["verdict"] != "invalid"]
        concl_ctl = [r for r in controls if r["verdict"] != "invalid"]
        caught = sum(1 for r in defects if r["verdict"] == "fail")
        fps = sum(1 for r in controls if r["verdict"] == "fail")
        tpr = caught / len(concl_def) if concl_def else 0.0
        fpr = fps / len(concl_ctl) if concl_ctl else 0.0
        tokens = [float(r["payloadTokens"]) for r in cells if r["payloadTokens"] != ""]
        ms = [float(r["wallClockMs"]) for r in cells if r["wallClockMs"] != ""]
        out[gate] = {
            "defects": len(defects),
            "caught": caught,
            "controls": len(controls),
            "fps": fps,
            "tpr": tpr,
            "fpr": fpr,
            "mean_tokens": sum(tokens) / len(tokens) if tokens else 0.0,
            "mean_ms": sum(ms) / len(ms) if ms else 0.0,
        }
    return out


# ── Figure — catch rate + cost ────────────────────────────────────────────────
def figure():
    d = load()
    W, H = 940, 460
    lines = svg_open(W, H, "Mechanical-gate catch rate and measured cost (#1675)")
    lines.append(
        text(W / 2, 26, "#1675 · Mechanical-gate catch rate + measured cost over the seeded-defect corpus",
             size=15, weight="600")
    )
    lines.append(
        text(W / 2, 45,
             "5 seeded defects + 5 matched controls per gate, driven through the real handlers in disposable worktrees",
             size=12, fill=FG)
    )

    # ── Panel A: catch rate (TPR) + false-positive rate (FPR) ──
    a_x0, a_x1 = 70, 470
    y0, y1 = 400, 110
    lines.append(text((a_x0 + a_x1) / 2, 72, "Catch rate (TPR) vs false-positive rate (FPR)", size=13, weight="600"))
    legend_centered(lines, (a_x0 + a_x1) / 2, 94,
                    [("catch rate (defects)", GREEN), ("false-positive (controls)", RED)])
    y_axis(lines, a_x0, y0, y1, 1.0, [0, 0.25, 0.5, 0.75, 1.0], fmt=lambda v: f"{int(v * 100)}%")
    vlabel(lines, a_x0 - 44, (y0 + y1) / 2, "rate")
    for t in [0.25, 0.5, 0.75, 1.0]:
        gridline(lines, a_x0, a_x1, y0 - t * (y0 - y1))
    slot = (a_x1 - a_x0 - 20) / len(GATES)
    gw = min(24, slot / 2 - 4)
    for i, (gate, label) in enumerate(GATES):
        cx = a_x0 + 16 + i * slot
        for j, (v, color) in enumerate([(d[gate]["tpr"], GREEN), (d[gate]["fpr"], RED)]):
            hh = v * (y0 - y1)
            xx = cx + j * (gw + 3)
            if hh < 2:  # a zero bar still shows a visible stub + label
                lines.append(rect(xx, y0 - 2, gw, 2, color))
                lines.append(text(xx + gw / 2, y0 - 6, "0%", size=9, fill=color))
            else:
                lines.append(rect(xx, y0 - hh, gw, hh, color))
                lines.append(text(xx + gw / 2, y0 - hh - 4, f"{int(round(v * 100))}%", size=9, fill=color))
        lines.append(text(cx + gw + 1.5, y0 + 16, label, size=10))

    # ── Panel B: measured cost — mean payload tokens (bars) + mean ms (label) ──
    b_x0, b_x1 = 560, W - 30
    lines.append(text((b_x0 + b_x1) / 2, 72, "Measured cost — mean payload tokens (ms above bar)", size=13, weight="600"))
    legend_centered(lines, (b_x0 + b_x1) / 2, 94, [("mean payload tokens", BLUE)])
    tok_max = max(1.0, max(d[g]["mean_tokens"] for g, _ in GATES))
    vmax = _nice_ceiling(tok_max)
    ticks = [0, vmax / 2, vmax]
    y_axis(lines, b_x0, y0, y1, vmax, ticks, fmt=lambda v: f"{int(v)}")
    vlabel(lines, b_x0 - 40, (y0 + y1) / 2, "tokens")
    for t in ticks[1:]:
        gridline(lines, b_x0, b_x1, y0 - (t / vmax) * (y0 - y1))
    slot = (b_x1 - b_x0 - 20) / len(GATES)
    gw = min(38, slot - 14)
    for i, (gate, label) in enumerate(GATES):
        cx = b_x0 + 16 + i * slot
        v = d[gate]["mean_tokens"]
        hh = (v / vmax) * (y0 - y1)
        lines.append(rect(cx, y0 - hh, gw, hh, BLUE))
        lines.append(text(cx + gw / 2, y0 - hh - 15, f"{d[gate]['mean_ms']:.0f}ms", size=9, fill=GRAY))
        lines.append(text(cx + gw / 2, y0 - hh - 4, f"{v:.0f}", size=9, fill=BLUE))
        lines.append(text(cx + gw / 2, y0 + 16, label, size=10))

    lines.append(
        text((b_x0 + b_x1) / 2, y0 + 36,
             "cost is a small-fixture-tree floor — production trees run larger, esp. integration-suite",
             size=10, fill=GRAY)
    )

    save(lines, "chart-gate-catch-rate.svg")


def _nice_ceiling(v):
    """Round a positive max up to a clean axis ceiling (deterministic)."""
    import math
    if v <= 0:
        return 1.0
    exp = math.floor(math.log10(v))
    base = 10 ** exp
    for m in (1, 2, 2.5, 5, 10):
        if v <= m * base:
            return m * base
    return 10 * base


def main():
    print("Generating #1675 gate-catch-rate figure from the committed CSV:")
    figure()
    print("Done.")


if __name__ == "__main__":
    main()
