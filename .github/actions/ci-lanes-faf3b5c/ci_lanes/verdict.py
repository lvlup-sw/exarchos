"""Decide whether a gate job passes.

A gate exists where GitHub cannot report a skipped job under the context a ruleset requires (a
matrix skipped at job level never creates its per-leg contexts). The gate is required instead, and
it is strict by default: every job it needs must SUCCEED. A ``skipped`` result is accepted only
when all three hold:

1. the manifest maps that job to a lane for this gate,
2. the planner job succeeded, and
3. the planner's output for that lane is exactly the string ``"false"``.

A skip after a planner failure, a skip of a relevant lane, a skip of a lane the planner did not
report, and any failure or cancellation all fail the gate. Unreadable input is INDETERMINATE.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from .errors import Indeterminate
from .manifest import Manifest

RESULTS = frozenset({"success", "failure", "cancelled", "skipped"})


@dataclass(frozen=True)
class JobVerdict:
    job: str
    lane: str
    result: str
    passed: bool
    reason: str


@dataclass(frozen=True)
class GateVerdict:
    gate: str
    planner_result: str
    structure_problems: tuple[str, ...]
    jobs: tuple[JobVerdict, ...]

    @property
    def passed(self) -> bool:
        return not self.structure_problems and all(job.passed for job in self.jobs)


def evaluate(manifest: Manifest, gate_key: str, needs_json: str) -> GateVerdict:
    gate = manifest.gates.get(gate_key)
    if gate is None:
        raise Indeterminate(f"the manifest declares no gate {gate_key!r}")
    if not needs_json.strip():
        raise Indeterminate("the needs context is empty; pass needs: ${{ toJSON(needs) }}")
    try:
        needs = json.loads(needs_json)
    except json.JSONDecodeError as error:
        raise Indeterminate(f"the needs context is not JSON: {error}") from error
    if not isinstance(needs, dict) or not needs:
        raise Indeterminate("the needs context did not parse to a non-empty object")

    results: dict[str, str] = {}
    for job, entry in needs.items():
        result = entry.get("result") if isinstance(entry, dict) else None
        if not isinstance(result, str) or result not in RESULTS:
            raise Indeterminate(f"needs.{job}.result is {result!r}, not one of {sorted(RESULTS)}")
        results[str(job)] = result

    planner = manifest.planner_job
    if planner not in results:
        raise Indeterminate(f"gate {gate_key} does not need the planner job {planner}, so no skip can be licensed")

    problems: list[str] = []
    expected = {planner, *gate.jobs}
    unexpected = sorted(set(results) - expected)
    missing = sorted(expected - set(results))
    if unexpected:
        problems.append(f"needs job(s) the manifest does not map to this gate: {', '.join(unexpected)}")
    if missing:
        problems.append(f"does not need job(s) the manifest maps to this gate: {', '.join(missing)}")

    planner_result = results[planner]
    lanes = _planner_lanes(needs[planner]) if planner_result == "success" else None

    verdicts: list[JobVerdict] = []
    for job in sorted(gate.jobs):
        lane = gate.jobs[job]
        result = results.get(job)
        if result is None:
            continue
        verdicts.append(_judge(job, lane, result, planner_result, lanes))
    return GateVerdict(gate_key, planner_result, tuple(problems), tuple(verdicts))


def _planner_lanes(entry: object) -> dict[str, str]:
    outputs = entry.get("outputs") if isinstance(entry, dict) else None
    raw = outputs.get("lanes") if isinstance(outputs, dict) else None
    if not isinstance(raw, str) or not raw:
        raise Indeterminate("the planner succeeded but exposes no lanes output")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise Indeterminate(f"the planner lanes output is not JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise Indeterminate("the planner lanes output is not an object")
    lanes: dict[str, str] = {}
    for key, value in parsed.items():
        if value not in ("true", "false"):
            raise Indeterminate(f"the planner lanes output gives {key!r} the value {value!r}, not 'true' or 'false'")
        lanes[str(key)] = str(value)
    return lanes


def _judge(job: str, lane: str, result: str, planner_result: str, lanes: dict[str, str] | None) -> JobVerdict:
    if result == "success":
        return JobVerdict(job, lane, result, True, "ran and succeeded")
    if result != "skipped":
        return JobVerdict(job, lane, result, False, f"{result}")
    if lanes is None:
        return JobVerdict(job, lane, result, False, f"skipped, but the planner result is {planner_result}, so no skip is licensed")
    value = lanes.get(lane)
    if value is None:
        return JobVerdict(job, lane, result, False, f"skipped, but the planner reported no lane {lane}")
    if value != "false":
        return JobVerdict(job, lane, result, False, f"skipped although lane {lane} is relevant")
    return JobVerdict(job, lane, result, True, f"skipped; lane {lane} is not touched by this change")


def render_verdict(verdict: GateVerdict, *, markdown: bool) -> str:
    status = "PASS" if verdict.passed else "FAIL"
    if not markdown:
        lines = [f"ci-lanes verdict for gate {verdict.gate}: {status} (planner: {verdict.planner_result})"]
        lines += [f"  structure: {problem}" for problem in verdict.structure_problems]
        lines += [
            f"  {job.job} [{job.lane}]: {job.result} -> {'ok' if job.passed else 'BLOCKS'} ({job.reason})"
            for job in verdict.jobs
        ]
        return "\n".join(lines)
    lines = [f"### CI lanes: gate `{verdict.gate}` {status}", "", f"Planner result: `{verdict.planner_result}`", ""]
    lines += [f"- **Structure:** {problem}" for problem in verdict.structure_problems]
    lines += ["| Job | Lane | Result | Verdict |", "|---|---|---|---|"]
    lines += [
        f"| `{job.job}` | `{job.lane}` | {job.result} | {'ok' if job.passed else '**blocks**'}: {job.reason} |"
        for job in verdict.jobs
    ]
    return "\n".join(lines) + "\n"
