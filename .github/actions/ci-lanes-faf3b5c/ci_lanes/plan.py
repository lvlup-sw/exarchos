"""Decide which lanes a change touches.

Only a ``pull_request`` event is narrowed. Every other event (push, merge_group, schedule,
workflow_dispatch) runs every lane: a push to the default branch is the backstop that catches a
lane whose path set misses something its job reads.
"""

from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from .errors import Indeterminate
from .manifest import Manifest, is_repo_relative

SHA = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
DIFFABLE_EVENT = "pull_request"
_SHOWN = 10


@dataclass(frozen=True)
class LaneDecision:
    key: str
    relevant: bool
    matched: tuple[str, ...]


@dataclass(frozen=True)
class Plan:
    reason: str
    changed_count: int | None
    decisions: tuple[LaneDecision, ...]

    def relevant(self, key: str) -> bool:
        for decision in self.decisions:
            if decision.key == key:
                return decision.relevant
        raise Indeterminate(f"the plan has no lane {key!r}")

    def lanes_json(self) -> str:
        values = {decision.key: "true" if decision.relevant else "false" for decision in self.decisions}
        return json.dumps(values, sort_keys=True, separators=(",", ":"))


def changed_paths(repo: Path, base_sha: str, head_sha: str) -> tuple[str, ...]:
    for label, sha in (("base", base_sha), ("head", head_sha)):
        if SHA.fullmatch(sha) is None:
            raise Indeterminate(f"a pull_request plan needs a full lowercase hex {label} SHA, got {sha!r}")
    # --no-renames lists a rename as its old AND new path, so moving a file out of a lane still
    # selects the lane. It also keeps the diff name-only, which a blobless clone can answer
    # without fetching file contents.
    command = [
        "git", "-c", "core.hooksPath=/dev/null", "-c", "core.quotepath=false", "-C", str(repo),
        "diff", "--name-only", "--no-renames", "--no-relative", "--no-ext-diff", "-z",
        f"{base_sha}...{head_sha}", "--",
    ]
    try:
        completed = subprocess.run(command, check=False, capture_output=True)
    except OSError as error:
        raise Indeterminate(f"git could not start: {error}") from error
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        raise Indeterminate(
            f"git diff {base_sha}...{head_sha} failed ({completed.returncode}): {detail}. "
            "The planner checkout needs both commits and their merge base (fetch-depth: 0)."
        )
    try:
        listing = completed.stdout.decode("utf-8")
    except UnicodeDecodeError as error:
        raise Indeterminate(f"git diff listed a path that is not UTF-8: {error}") from error
    return tuple(sorted({path for path in listing.split("\0") if path}))


def plan_for_event(manifest: Manifest, event_name: str, changed: Iterable[str] | None) -> Plan:
    if not event_name:
        raise Indeterminate("the event name is empty")
    if event_name != DIFFABLE_EVENT:
        return _every_lane(manifest, f"Event `{event_name}` is not a pull request, so every lane runs", None)
    if changed is None:
        raise Indeterminate("a pull_request plan needs the changed paths")
    return plan_for_files(manifest, changed)


def plan_for_files(manifest: Manifest, files: Iterable[str]) -> Plan:
    changed = tuple(sorted(set(files)))
    if not changed:
        raise Indeterminate("the change lists zero paths, and a plan over nothing is not a plan")
    for path in changed:
        if not is_repo_relative(path):
            raise Indeterminate(f"changed path is not repository-relative: {path!r}")
    if manifest.path in changed:
        return _every_lane(manifest, f"The manifest `{manifest.path}` changed, so every lane runs", len(changed))
    decisions = []
    for key in sorted(manifest.lanes):
        lane = manifest.lanes[key]
        matched = tuple(path for path in changed if lane.matches(path))
        decisions.append(LaneDecision(key, bool(matched), matched))
    return Plan("Lanes selected from the pull request diff", len(changed), tuple(decisions))


def _every_lane(manifest: Manifest, reason: str, changed_count: int | None) -> Plan:
    return Plan(reason, changed_count, tuple(LaneDecision(key, True, ()) for key in sorted(manifest.lanes)))


def render_plan(plan: Plan, *, markdown: bool) -> str:
    if not markdown:
        lines = [f"ci-lanes plan: {plan.reason}"]
        if plan.changed_count is not None:
            lines.append(f"  changed paths: {plan.changed_count}")
        for decision in plan.decisions:
            verdict = "runs" if decision.relevant else "skips"
            shown = ", ".join(decision.matched[:_SHOWN])
            more = f" (+{len(decision.matched) - _SHOWN} more)" if len(decision.matched) > _SHOWN else ""
            lines.append(f"  {decision.key}: {verdict}" + (f" <- {shown}{more}" if shown else ""))
        return "\n".join(lines)
    lines = ["### CI lanes: plan", "", f"{plan.reason}."]
    if plan.changed_count is not None:
        lines += ["", f"Changed paths: {plan.changed_count}"]
    lines += ["", "| Lane | Runs | Matched paths |", "|---|---|---|"]
    for decision in plan.decisions:
        shown = ", ".join(f"`{_cell(path)}`" for path in decision.matched[:_SHOWN])
        more = f" (+{len(decision.matched) - _SHOWN} more)" if len(decision.matched) > _SHOWN else ""
        lines.append(f"| `{decision.key}` | {'yes' if decision.relevant else 'no'} | {shown}{more} |")
    return "\n".join(lines) + "\n"


def _cell(value: str) -> str:
    return value.replace("|", "\\|").replace("`", "'")
