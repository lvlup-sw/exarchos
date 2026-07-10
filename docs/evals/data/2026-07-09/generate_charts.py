#!/usr/bin/env python3
"""Generate the #1670 delegation-pipeline benchmark figure SVGs from committed CSVs.

Three figures, one per executed experiment, mirroring the *bifrost* benchmark
charting standard (docs/benchmarks/2026-06-13-cpq-xeon-8573c.md):

    Figure 1 (Exp 1) — chart-exp1-verification-depth.svg
        Verification depth before vs after the #1669 stamp-lift fix: risk-tier
        distribution + per-check application counts, driven through the real
        binary. Causal pair (== released pair exactly).
    Figure 2 (Exp 2) — chart-exp2-native-distribution.svg
        Measured native per-subagent model distribution across two real
        `claude -p` runs — the artifact that retires NATIVE_FLAT_MODEL='opus'.
    Figure 3 (Exp 3) — chart-exp3-correctness-vs-process.svg
        Correctness (hidden oracle) vs process (durable mutation-adequate tests)
        under under-specification, E (verification steer) vs N (bare), opus+sonnet.

Style note (deliberate, read before "why not matplotlib?"): the bifrost reference
generator this mirrors is itself **pure Python stdlib SVG, not matplotlib**
(`data/azure-d64sv6-2026-06-13/generate_charts.py` says so in its own docstring).
Hand-written SVG is byte-for-byte deterministic (matplotlib embeds a nondeterministic
`<dc:date>` and clip-path ids by default) and needs no third-party install, which is
exactly what DR-6 asks for: charts that "regenerate deterministically from committed
data" with "no network access." So this script is data-driven, pure stdlib, and
reproduces identical bytes on every run.

    python3 docs/evals/data/2026-07-09/generate_charts.py

GitHub palette + transparent background, so the SVGs sit correctly in both light and
dark GitHub themes (the FG gray reads on either).
"""

import csv
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent

# ── GitHub palette (theme-agnostic; the gray FG reads on light and dark) ──────
FG = "#8b949e"       # axes, labels, gridlines
BLUE = "#58a6ff"     # "before" / bare-N / medium tier
ORANGE = "#f0883e"   # "after" / steer-E / measured / high tier
GREEN = "#3fb950"    # positive / low tier / tests present
RED = "#f85149"      # gap / missing
GRAY = "#6e7681"     # neutral / assumed
FONT = "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"


# ── SVG helpers (mirror the bifrost generator) ────────────────────────────────
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


# ── data loading ──────────────────────────────────────────────────────────────
def _rows(path):
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def load_exp1(pair="causal"):
    rows = [r for r in _rows(HERE / "exp1-before-after.csv") if r["pair"] == pair]
    total = len(rows)
    changed = sum(1 for r in rows if r["changed"] == "true")
    before_tier = _tier_counts(rows, "beforeTier")
    after_tier = _tier_counts(rows, "afterTier")
    checks = ["check_static_analysis", "check_test_adequacy",
              "check_integration_suite", "check_contract_drift", "check_mock_boundary"]
    before_checks = {c: sum(1 for r in rows if c in r["beforeSequence"]) for c in checks}
    after_checks = {c: sum(1 for r in rows if c in r["afterSequence"]) for c in checks}
    return {"total": total, "changed": changed, "before_tier": before_tier,
            "after_tier": after_tier, "before_checks": before_checks,
            "after_checks": after_checks, "checks": checks,
            "released_equal": _released_equals_causal()}


def _tier_counts(rows, col):
    c = {"low": 0, "medium": 0, "high": 0}
    for r in rows:
        c[r[col]] = c.get(r[col], 0) + 1
    return c


def _released_equals_causal():
    """True iff the released pair's changed-set is identical to the causal pair's
    (→ #1659 adds zero delta). Compared per-(spec,task) on tier+boundary+steps."""
    allrows = _rows(HERE / "exp1-before-after.csv")

    def sig(rs):
        return {
            (r["spec"], r["task"]): (r["afterTier"], r["afterBoundary"], r["afterSequence"])
            for r in rs
        }

    causal = sig([r for r in allrows if r["pair"] == "causal"])
    released = sig([r for r in allrows if r["pair"] == "released"])
    return causal == released


def load_exp2():
    rows = _rows(HERE / "exp2-native-baseline.csv")
    per_model = defaultdict(int)
    per_run = defaultdict(lambda: defaultdict(int))
    for r in rows:
        per_model[r["model"]] += 1
        per_run[r["run"]][r["model"]] += 1
    distinct = len(per_model)
    return {"per_model": dict(per_model), "per_run": {k: dict(v) for k, v in per_run.items()},
            "distinct": distinct, "runs": sorted(per_run.keys()),
            "session_model": rows[0]["modelIds"] if rows else ""}


def load_exp3():
    rows = _rows(HERE / "exp3-underspec-ab.csv")
    cells = defaultdict(list)
    for r in rows:
        cells[(r["model"], r["arm"])].append(r)
    out = {}
    for k, rs in cells.items():
        n = len(rs)
        oracle_mean = sum(float(r["oracleRate"]) for r in rs) / n
        # a "durable, mutation-adequate" cell: it wrote tests AND the mutation gate
        # killed every mutant (adequacyScore == 1). Cells with no new tests never count.
        adequate = sum(1 for r in rs
                       if r["wroteTests"] == "true"
                       and r["adequacyProbed"] == "true"
                       and r["adequacyScore"] not in ("", "0")
                       and float(r["adequacyScore"]) >= 0.9999)
        out[k] = {"n": n, "oracle_mean": oracle_mean, "adequate": adequate}
    return out


# ── axis scaffold ─────────────────────────────────────────────────────────────
def y_axis(lines, x, y0, y1, vmax, ticks, fmt=lambda v: f"{v:g}"):
    """Vertical axis from (x,y0=bottom) up to y1=top mapping 0..vmax; draws ticks."""
    lines.append(line(x, y0, x, y1, stroke=FG, width=1.2))
    for t in ticks:
        yy = y0 - (t / vmax) * (y0 - y1)
        lines.append(line(x - 4, yy, x, yy, stroke=FG, width=1.0))
        lines.append(line(x, yy, x + 9999, yy, stroke=FG, width=0.4, dash="2 4")) if False else None
        lines.append(text(x - 8, yy + 4, fmt(t), size=11, anchor="end"))


def gridline(lines, x0, x1, y, dash="2 5"):
    lines.append(line(x0, y, x1, y, stroke=FG, width=0.5, dash=dash))


# ── Figure 1 — Exp 1 verification depth ───────────────────────────────────────
def figure_exp1():
    d = load_exp1("causal")
    W, H = 940, 460
    lines = svg_open(W, H, "Verification depth before vs after the #1669 stamp-lift fix")
    lines.append(text(W / 2, 26, "Exp 1 · Verification depth through the real binary — before vs after #1669",
                      size=15, weight="600"))
    pct = round(100 * d["changed"] / d["total"])
    sub = (f"{d['changed']} of {d['total']} tasks changed tier or verification ({pct}%)  ·  "
           f"causal pair {'=' if d['released_equal'] else '!='} released pair "
           f"-> #1659 adds {'zero' if d['released_equal'] else 'a'} delta")
    lines.append(text(W / 2, 45, sub, size=12, fill=FG))

    # ── Panel A: risk-tier distribution (stacked) ──
    ax = 70
    a_x0, a_x1 = ax, ax + 300
    y0, y1 = 400, 112
    vmax = d["total"]
    ticks = [0, 31, 62, 93, 124]
    lines.append(text((a_x0 + a_x1) / 2, 72, "Risk tier assigned (tasks)", size=13, weight="600"))
    legend_centered(lines, (a_x0 + a_x1) / 2, 94, [("high", ORANGE), ("medium", BLUE), ("low", GREEN)])
    y_axis(lines, a_x0, y0, y1, vmax, ticks)
    vlabel(lines, a_x0 - 42, (y0 + y1) / 2, "tasks")
    bw = 90
    for i, (label, dist) in enumerate([("before\n(heuristic)", d["before_tier"]),
                                       ("after\n(stamp-lift)", d["after_tier"])]):
        bx = a_x0 + 55 + i * 150
        # draw stacked from bottom: low, medium, high
        acc = 0
        for tier, color in [("low", GREEN), ("medium", BLUE), ("high", ORANGE)]:
            v = dist.get(tier, 0)
            if v == 0:
                continue
            hh = (v / vmax) * (y0 - y1)
            yy = y0 - (acc + v) / vmax * (y0 - y1)
            lines.append(rect(bx, yy, bw, hh, color))
            if hh > 16:
                lines.append(text(bx + bw / 2, yy + hh / 2 + 4, f"{tier} {v}", size=11, fill="#0d1117"))
            acc += v
        for j, ln in enumerate(label.split("\n")):
            lines.append(text(bx + bw / 2, y0 + 18 + j * 15, ln, size=11))

    # ── Panel B: per-check application counts (grouped before/after) ──
    b_x0 = 560
    b_x1 = W - 30
    lines.append(text((b_x0 + b_x1) / 2, 72, "Verification checks applied (tasks)", size=13, weight="600"))
    legend_centered(lines, (b_x0 + b_x1) / 2, 94, [("before (heuristic)", BLUE), ("after (stamp-lift)", ORANGE)])
    y_axis(lines, b_x0, y0, y1, vmax, ticks)
    check_labels = {"check_static_analysis": "static", "check_test_adequacy": "test-adeq",
                    "check_integration_suite": "integ-suite", "check_contract_drift": "contract",
                    "check_mock_boundary": "mock-bnd"}
    n = len(d["checks"])
    slot = (b_x1 - b_x0 - 20) / n
    gw = min(26, slot / 2 - 4)
    for i, c in enumerate(d["checks"]):
        cx = b_x0 + 20 + i * slot
        bv = d["before_checks"][c]
        av = d["after_checks"][c]
        for j, (v, color) in enumerate([(bv, BLUE), (av, ORANGE)]):
            hh = (v / vmax) * (y0 - y1)
            xx = cx + j * (gw + 3)
            lines.append(rect(xx, y0 - hh, gw, hh, color))
            lines.append(text(xx + gw / 2, y0 - hh - 4, str(v), size=10))
        lines.append(text(cx + gw + 1.5, y0 + 16, check_labels[c], size=10))

    save(lines, "chart-exp1-verification-depth.svg")


# ── Figure 2 — Exp 2 native model distribution ────────────────────────────────
def figure_exp2():
    d = load_exp2()
    W, H = 640, 400
    lines = svg_open(W, H, "Measured native per-subagent model distribution")
    lines.append(text(W / 2, 26, "Exp 2 · Measured native model distribution (2 real `claude -p` runs)",
                      size=15, weight="600"))
    total = sum(d["per_model"].values())
    lines.append(text(W / 2, 45,
                      f"{total} subagents dispatched · distinct models = {d['distinct']} "
                      f"-> native inherits the session model, not a mix",
                      size=12, fill=FG))

    ax = 70
    y0, y1 = 320, 90
    vmax = 3
    y_axis(lines, ax, y0, y1, vmax, [0, 1, 2, 3])
    vlabel(lines, ax - 40, (y0 + y1) / 2, "subagents")
    # one stacked bar per run, colored by model (all = session model → one solid color)
    model_color = {"claude-sonnet-5": ORANGE}
    runs = d["runs"]
    bw = 120
    gap = 60
    x0 = ax + 70
    for i, run in enumerate(runs):
        bx = x0 + i * (bw + gap)
        acc = 0
        for model, cnt in sorted(d["per_run"][run].items()):
            color = model_color.get(model, GRAY)
            hh = (cnt / vmax) * (y0 - y1)
            yy = y0 - (acc + cnt) / vmax * (y0 - y1)
            lines.append(rect(bx, yy, bw, hh, color))
            lines.append(text(bx + bw / 2, yy + hh / 2 + 4, f"{model} ×{cnt}", size=11, fill="#0d1117"))
            acc += cnt
        lines.append(text(bx + bw / 2, y0 + 18, run, size=12))
        lines.append(text(bx + bw / 2, y0 + 34, "streamed" if run == "r1" else "notification-only",
                          size=10, fill=FG))
    # retired-assumption annotation
    lines.append(line(x0 - 20, y1 - 22, W - 30, y1 - 22, stroke=GRAY, width=0.6, dash="3 4"))
    lines.append(text((x0 + W - 30) / 2 - 25, y1 - 30,
                      "retired assumption: NATIVE_FLAT_MODEL = 'opus' (never measured)",
                      size=11, fill=GRAY))
    save(lines, "chart-exp2-native-distribution.svg")


# ── Figure 3 — Exp 3 correctness vs process ───────────────────────────────────
def figure_exp3():
    d = load_exp3()
    order = [("opus", "E"), ("opus", "N"), ("sonnet", "E"), ("sonnet", "N")]
    labels = {("opus", "E"): "opus·E", ("opus", "N"): "opus·N",
              ("sonnet", "E"): "sonnet·E", ("sonnet", "N"): "sonnet·N"}
    arm_color = {"E": ORANGE, "N": BLUE}
    W, H = 940, 430
    lines = svg_open(W, H, "Correctness vs process under under-specification, E vs N")
    lines.append(text(W / 2, 26, "Exp 3 · Under-specified tasks — E (verification steer) vs N (bare)",
                      size=15, weight="600"))
    lines.append(text(W / 2, 45,
                      "correctness ties (clean null); the steer's value is process — durable, mutation-adequate tests",
                      size=12, fill=FG))

    # Panel A: hidden-oracle mean pass rate (all ≈ tie)
    a_x0, a_x1 = 70, 440
    y0, y1 = 372, 96
    lines.append(text((a_x0 + a_x1) / 2, 74, "Hidden-oracle correctness (mean pass rate)", size=13, weight="600"))
    y_axis(lines, a_x0, y0, y1, 1.0, [0, 0.25, 0.5, 0.75, 1.0], fmt=lambda v: f"{v:.2f}")
    vlabel(lines, a_x0 - 46, (y0 + y1) / 2, "pass rate")
    for t in [0.25, 0.5, 0.75, 1.0]:
        gridline(lines, a_x0, a_x1, y0 - t * (y0 - y1))
    slot = (a_x1 - a_x0 - 30) / len(order)
    gw = min(46, slot - 18)
    for i, k in enumerate(order):
        cx = a_x0 + 30 + i * slot
        v = d[k]["oracle_mean"]
        hh = v * (y0 - y1)
        lines.append(rect(cx, y0 - hh, gw, hh, arm_color[k[1]]))
        lines.append(text(cx + gw / 2, y0 - hh - 5, f"{v:.3f}", size=10))
        lines.append(text(cx + gw / 2, y0 + 16, labels[k], size=10))
    lines.append(text((a_x0 + a_x1) / 2, y0 + 36, "E = N  (no correctness gap)", size=12, fill=GREEN, weight="600"))

    # Panel B: durable mutation-adequate test cells (out of 6)
    b_x0, b_x1 = 540, W - 30
    lines.append(text((b_x0 + b_x1) / 2, 74, "Durable mutation-adequate tests (cells of 6)", size=13, weight="600"))
    y_axis(lines, b_x0, y0, y1, 6, [0, 2, 4, 6])
    vlabel(lines, b_x0 - 40, (y0 + y1) / 2, "cells")
    for t in [2, 4, 6]:
        gridline(lines, b_x0, b_x1, y0 - (t / 6) * (y0 - y1))
    slot = (b_x1 - b_x0 - 30) / len(order)
    gw = min(46, slot - 18)
    for i, k in enumerate(order):
        cx = b_x0 + 30 + i * slot
        v = d[k]["adequate"]
        hh = (v / 6) * (y0 - y1)
        color = arm_color[k[1]] if v > 0 else RED
        if v == 0:
            lines.append(rect(cx, y0 - 3, gw, 3, RED))
            lines.append(text(cx + gw / 2, y0 - 8, "0", size=10, fill=RED))
        else:
            lines.append(rect(cx, y0 - hh, gw, hh, color))
            lines.append(text(cx + gw / 2, y0 - hh - 5, f"{v}/6", size=10))
        lines.append(text(cx + gw / 2, y0 + 16, labels[k], size=10))
    lines.append(text((b_x0 + b_x1) / 2, y0 + 36, "E: 12/12   ·   N: opus 3/6, sonnet 0/6", size=12, fill=ORANGE, weight="600"))

    save(lines, "chart-exp3-correctness-vs-process.svg")


def main():
    print("Generating #1670 benchmark figures from committed CSVs:")
    figure_exp1()
    figure_exp2()
    figure_exp3()
    print("Done.")


if __name__ == "__main__":
    main()
