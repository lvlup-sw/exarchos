"""Static contract between a ci-lanes manifest and the workflows that read it.

This mode imports PyYAML, so the action runs it with the pinned dependency. ``plan`` and
``verdict`` never import it.

Per workflow the manifest names, it proves:

* the planner job runs the action once, from a full-history checkout, and exposes its ``lanes``;
* every inline job that needs the planner carries the byte-exact fail-closed skip, and a matrix
  job does so only when a gate covers it (a matrix skipped at job level never creates its
  per-leg check contexts);
* every reusable-workflow caller that needs the planner passes the byte-exact ``enabled:``
  expression. Its caller-level ``if:`` is not constrained: a skipped caller reports a check named
  after the caller alone, so it can leave a required ``caller / job`` context unreported, but it
  can never turn that context green;
* every gate runs ``verdict`` over exactly the planner plus the jobs the manifest maps to it;
* every in-step selector names a declared lane;
* every repository path a targeted job names is inside that job's lane;
* nothing that decides a skip carries ``continue-on-error``.

Across the manifest it proves every glob still matches a tracked file, every lane is read by some
job, every exemption still exists, and every fixture replays to its expected decisions.
"""

from __future__ import annotations

import posixpath
import re
import subprocess
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .errors import Indeterminate
from .manifest import Gate, Lane, Manifest
from .plan import plan_for_files

# Paved-road pin is @v1 (or @v1.N). A 40-char SHA remains valid for repos that
# opt out of the moving tag. The in-repo relative path is the canary / self-test.
ACTION_REFERENCE = re.compile(
    r"lvlup\-sw/exarchos/\.github/actions/ci\-lanes\-faf3b5c@[0-9a-f]{40}|\./actions/ci-lanes"
)
LANE_REFERENCE = re.compile(
    r"fromJSON\(\s*needs\.(?P<planner>[A-Za-z_][A-Za-z0-9_-]*)\.outputs\.lanes\s*\)\.(?P<lane>[A-Za-z0-9_]+)"
)
_TOKEN_SEPARATORS = re.compile(r"[\s\"'`=,;()<>|&]+")
_ROOT_RELATIVE_STEP_KEYS = ("with", "env", "working-directory")
_LISTED = 5

# A string a job reads, paired with the directory its relative paths resolve against: "" is the
# repository root, and None means the directory is built at run time and cannot be resolved.
TextAt = tuple[str, "str | None"]


def canonical_clause(planner: str, lane: str) -> str:
    return f"needs.{planner}.result != 'success' || fromJSON(needs.{planner}.outputs.lanes).{lane} != 'false'"


# The leading status guard of a targeted job and of a gate. `!cancelled()` is canonical: a
# cancelled run (a superseded push under `cancel-in-progress`) starts none of its pending jobs.
# `always()` still passes the check, but it starts every pending job of a cancelled run.
CANONICAL_GUARD = "!cancelled()"
LEGACY_GUARD = "always()"


def canonical_skip(planner: str, lane: str, guard: str = CANONICAL_GUARD) -> str:
    return "${{ " + guard + " && (" + canonical_clause(planner, lane) + ") }}"


def accepted_skips(planner: str, lane: str) -> tuple[str, str]:
    return (canonical_skip(planner, lane), canonical_skip(planner, lane, LEGACY_GUARD))


def canonical_enable(planner: str, lane: str) -> str:
    return "${{ " + canonical_clause(planner, lane) + " }}"


@dataclass
class CheckResult:
    violations: list[str] = field(default_factory=list)
    assertions: int = 0

    def require(self, condition: bool, message: str) -> None:
        self.assertions += 1
        if not condition:
            self.violations.append(message)


class _UniqueKeyLoader(yaml.SafeLoader):
    """A SafeLoader that refuses duplicate mapping keys instead of silently keeping the last one."""


def _mapping_without_duplicates(loader: yaml.SafeLoader, node: yaml.MappingNode) -> dict[object, object]:
    loader.flatten_mapping(node)
    mapping: dict[object, object] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=True)
        try:
            duplicate = key in mapping
        except TypeError as error:
            raise yaml.constructor.ConstructorError(
                None, None, f"unhashable mapping key {key!r}", key_node.start_mark
            ) from error
        if duplicate:
            raise yaml.constructor.ConstructorError(None, None, f"duplicate mapping key {key!r}", key_node.start_mark)
        mapping[key] = loader.construct_object(value_node, deep=True)
    return mapping


_UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping_without_duplicates)


def run_check(repo: Path, manifest: Manifest) -> CheckResult:
    result = CheckResult()
    tracked = tracked_files(repo)
    directories = _directories(tracked)

    for lane in manifest.lanes.values():
        for name in lane.workflows:
            result.require(f".github/workflows/{name}" in tracked, f"lane {lane.key}: workflow {name} is not a tracked file")
        if lane.allow_empty is None:
            for glob in lane.globs:
                result.require(
                    any(glob.matches(path) for path in tracked),
                    f"lane {lane.key}: path {glob.pattern!r} matches no tracked file. A renamed or deleted "
                    "directory silently narrows the lane; fix the pattern, or set allow_empty with a reason.",
                )
        for path in lane.exempt_paths:
            result.require(path in tracked or path in directories, f"lane {lane.key}: exempt path {path} no longer exists")
    for gate in manifest.gates.values():
        result.require(
            f".github/workflows/{gate.workflow}" in tracked, f"gate {gate.job}: workflow {gate.workflow} is not a tracked file"
        )

    used_lanes: set[str] = set()
    workflow_names = sorted(
        {name for lane in manifest.lanes.values() for name in lane.workflows}
        | {gate.workflow for gate in manifest.gates.values()}
    )
    for name in workflow_names:
        if f".github/workflows/{name}" in tracked:
            _check_workflow(result, manifest, name, load_workflow(repo, name), tracked, directories, used_lanes)

    for lane in manifest.lanes.values():
        result.require(
            lane.key in used_lanes,
            f"lane {lane.key}: no job or step in {', '.join(lane.workflows)} reads it, so it decides nothing",
        )

    for fixture in manifest.fixtures:
        replay = plan_for_files(manifest, fixture.files)
        for lane_key, expected in sorted(fixture.expect.items()):
            actual = replay.relevant(lane_key)
            result.require(
                actual == expected,
                f"fixture {fixture.name!r}: lane {lane_key} is {str(actual).lower()}, expected {str(expected).lower()}",
            )
    return result


def tracked_files(repo: Path) -> frozenset[str]:
    command = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.quotepath=false", "-C", str(repo), "ls-files", "-z"]
    try:
        completed = subprocess.run(command, check=False, capture_output=True)
    except OSError as error:
        raise Indeterminate(f"git could not start: {error}") from error
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        raise Indeterminate(f"git ls-files failed ({completed.returncode}): {detail}")
    try:
        listing = completed.stdout.decode("utf-8")
    except UnicodeDecodeError as error:
        raise Indeterminate(f"git ls-files listed a path that is not UTF-8: {error}") from error
    files = frozenset(path for path in listing.split("\0") if path)
    if not files:
        raise Indeterminate("git ls-files lists zero tracked files, so no lane can be checked against the tree")
    return files


def load_workflow(repo: Path, name: str) -> dict[str, object]:
    relative = f".github/workflows/{name}"
    try:
        text = (repo / relative).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise Indeterminate(f"cannot read {relative}: {error}") from error
    try:
        document = yaml.load(text, Loader=_UniqueKeyLoader)  # noqa: S506 - SafeLoader subclass
    except yaml.YAMLError as error:
        raise Indeterminate(f"{relative} is not valid YAML: {error}") from error
    if not isinstance(document, dict) or not isinstance(document.get("jobs"), dict):
        raise Indeterminate(f"{relative} has no jobs mapping")
    return {str(key): value for key, value in document.items()}


def _check_workflow(
    result: CheckResult,
    manifest: Manifest,
    name: str,
    document: Mapping[str, object],
    tracked: frozenset[str],
    directories: frozenset[str],
    used_lanes: set[str],
) -> None:
    planner = manifest.planner_job
    jobs = _mapping(document.get("jobs"))
    gates = {gate.job: gate for gate in manifest.gates.values() if gate.workflow == name}
    gated = {job: gate for gate in gates.values() for job in gate.jobs}

    for gate in gates.values():
        result.require(gate.job in jobs, f"{name}: gate job {gate.job} does not exist")
        for covered in gate.jobs:
            result.require(covered in jobs, f"{name}: gate {gate.job} covers job {covered}, which does not exist")

    any_job_needs_planner = False
    for job_id, job_value in jobs.items():
        label = f"{name}:{job_id}"
        if not isinstance(job_value, dict):
            result.require(False, f"{label}: the job is not a mapping")
            continue
        job = _mapping(job_value)
        needs = _needs(job)
        references = _lane_references(job)

        for planner_name, lane_key in sorted(references):
            result.require(planner_name == planner, f"{label}: reads lanes from job {planner_name}, but the planner job is {planner}")
            known = lane_key in manifest.lanes and name in manifest.lanes[lane_key].workflows
            result.require(known, f"{label}: reads lane {lane_key}, which the manifest does not declare for {name}")
            if known:
                used_lanes.add(lane_key)

        _check_action_steps(result, manifest, name, label, job_id, job, needs, gates, tracked, directories, used_lanes)

        if job_id == planner:
            _check_planner(result, label, job)
            continue
        if job_id in gates:
            _check_gate(result, label, job, gates[job_id], planner)
            continue
        if planner not in needs:
            result.require(not references, f"{label}: reads planner lanes but does not need {planner}")
            if job_id in gated:
                result.require(False, f"{label}: gate {gated[job_id].job} covers this job, so it must need {planner}")
            continue

        any_job_needs_planner = True
        result.require("continue-on-error" not in job, f"{label}: a targeted job must not carry continue-on-error")
        lane_keys = sorted({lane_key for _, lane_key in references})
        if len(lane_keys) != 1:
            form = (
                "enabled: " + canonical_enable(planner, "<lane>")
                if isinstance(job.get("uses"), str)
                else "if: " + canonical_skip(planner, "<lane>")
            )
            result.require(
                False,
                f"{label}: needs {planner} but reads {len(lane_keys)} lanes; a targeted job belongs to exactly one "
                f"lane and must carry exactly {form}",
            )
            continue
        lane_key = lane_keys[0]
        if job_id in gated:
            mapped = gated[job_id].jobs[job_id]
            result.require(mapped == lane_key, f"{label}: gate {gated[job_id].job} maps this job to lane {mapped}, but it reads lane {lane_key}")

        texts: list[TextAt]
        if isinstance(job.get("uses"), str):
            enabled = _mapping(job.get("with")).get("enabled")
            expected = canonical_enable(planner, lane_key)
            result.require(
                isinstance(enabled, str) and enabled.strip() == expected,
                f"{label}: a reusable-workflow caller that needs {planner} must pass exactly enabled: {expected}",
            )
            texts = [(text, "") for text in _strings(job.get("with"))]
        else:
            condition = job.get("if")
            expected = canonical_skip(planner, lane_key)
            result.require(
                isinstance(condition, str) and condition.strip() in accepted_skips(planner, lane_key),
                f"{label}: a targeted job must carry exactly if: {expected}",
            )
            strategy = job.get("strategy")
            is_matrix = isinstance(strategy, dict) and "matrix" in strategy
            result.require(
                not is_matrix or job_id in gated,
                f"{label}: a matrix job skipped at job level never creates its per-leg check contexts; cover it with a gate",
            )
            texts = _job_texts(job)
        if lane_key in manifest.lanes:
            _coverage(result, label, manifest.lanes[lane_key], texts, tracked, directories)

    if any_job_needs_planner:
        result.require(planner in jobs, f"{name}: jobs need {planner}, but the workflow has no such job")


def _check_action_steps(
    result: CheckResult,
    manifest: Manifest,
    name: str,
    label: str,
    job_id: str,
    job: Mapping[str, object],
    needs: tuple[str, ...],
    gates: Mapping[str, Gate],
    tracked: frozenset[str],
    directories: frozenset[str],
    used_lanes: set[str],
) -> None:
    steps = _steps(job)
    for index, step in enumerate(steps):
        if not _is_action_step(step):
            continue
        result.require("continue-on-error" not in step, f"{label}: a ci-lanes step must not carry continue-on-error")
        with_map = _mapping(step.get("with"))
        mode = with_map.get("mode", "plan")
        if mode not in ("plan", "verdict", "check"):
            result.require(False, f"{label}: ci-lanes mode {mode!r} is not plan, verdict or check")
            continue
        if mode == "verdict":
            result.require(job_id in gates, f"{label}: only a gate the manifest declares may run mode: verdict")
        lane_key = with_map.get("lane", "")
        if lane_key == "":
            continue
        if mode != "plan":
            result.require(False, f"{label}: the lane input applies only to mode: plan")
            continue
        known = isinstance(lane_key, str) and lane_key in manifest.lanes and name in manifest.lanes[lane_key].workflows
        result.require(known, f"{label}: the in-step selector names lane {lane_key!r}, which the manifest does not declare for {name}")
        if not known or not isinstance(lane_key, str):
            continue
        used_lanes.add(lane_key)
        result.require(
            job_id != manifest.planner_job and manifest.planner_job not in needs,
            f"{label}: an in-step selector and a planner dependency are two decisions for one job; use one",
        )
        result.require(
            _has_full_history_checkout(steps[:index]),
            f"{label}: an in-step selector must follow a full-history checkout (fetch-depth: 0)",
        )
        _coverage(result, label, manifest.lanes[lane_key], _job_texts(job), tracked, directories)


def _check_planner(result: CheckResult, label: str, job: Mapping[str, object]) -> None:
    result.require("uses" not in job, f"{label}: the planner must be an inline job, not a reusable-workflow call")
    result.require("if" not in job, f"{label}: the planner must not be conditional")
    result.require("continue-on-error" not in job, f"{label}: the planner must not carry continue-on-error")
    steps = _steps(job)
    action_steps = [(index, step) for index, step in enumerate(steps) if _is_action_step(step)]
    result.require(len(action_steps) == 1, f"{label}: the planner must run the ci-lanes action exactly once")
    if len(action_steps) != 1:
        return
    index, step = action_steps[0]
    result.require(_mapping(step.get("with")).get("mode", "plan") == "plan", f"{label}: the planner must run mode: plan")
    step_id = step.get("id")
    expected = "${{ steps." + str(step_id) + ".outputs.lanes }}"
    lanes_output = _mapping(job.get("outputs")).get("lanes")
    result.require(
        isinstance(step_id, str) and isinstance(lanes_output, str) and lanes_output.strip() == expected,
        f"{label}: the planner must declare outputs.lanes exactly as {expected}",
    )
    result.require(
        _has_full_history_checkout(steps[:index]),
        f"{label}: the planner must check out full history (fetch-depth: 0) before planning",
    )


def _check_gate(result: CheckResult, label: str, job: Mapping[str, object], gate: Gate, planner: str) -> None:
    condition = job.get("if")
    result.require(
        isinstance(condition, str)
        and condition.strip() in (CANONICAL_GUARD, "${{ " + CANONICAL_GUARD + " }}", LEGACY_GUARD, "${{ " + LEGACY_GUARD + " }}"),
        f"{label}: a gate must run with if: ${{{{ {CANONICAL_GUARD} }}}}",
    )
    expected_needs = sorted({planner, *gate.jobs})
    result.require(sorted(set(_needs(job))) == expected_needs, f"{label}: a gate must need exactly {expected_needs}")
    result.require("strategy" not in job and "uses" not in job, f"{label}: a gate must be a single inline job")
    result.require("continue-on-error" not in job, f"{label}: a gate must not carry continue-on-error")
    action_steps = [step for step in _steps(job) if _is_action_step(step)]
    verdict_step = _mapping(action_steps[0].get("with")) if len(action_steps) == 1 else {}
    result.require(
        len(action_steps) == 1
        and verdict_step.get("mode") == "verdict"
        and verdict_step.get("gate") == gate.job
        and str(verdict_step.get("needs", "")).strip() == "${{ toJSON(needs) }}",
        f"{label}: a gate must run the ci-lanes action once with mode: verdict, gate: {gate.job}, and "
        "needs: ${{ toJSON(needs) }}",
    )


def _coverage(
    result: CheckResult,
    label: str,
    lane: Lane,
    texts: Iterable[TextAt],
    tracked: frozenset[str],
    directories: frozenset[str],
) -> None:
    seen: set[str] = set()
    for text, base in texts:
        for token in path_tokens(text, base, tracked, directories):
            if token in seen:
                continue
            seen.add(token)
            if token in lane.exempt_paths:
                continue
            if token in tracked:
                result.require(
                    lane.matches(token),
                    f"{label}: names {token}, which lane {lane.key} does not match. Add it to the lane's paths, "
                    "or to exempt_paths with a reason.",
                )
                continue
            prefix = token + "/"
            outside = sorted(
                path for path in tracked if path.startswith(prefix) and not lane.matches(path) and path not in lane.exempt_paths
            )
            result.require(
                not outside,
                f"{label}: names directory {token}/, but lane {lane.key} does not match {len(outside)} file(s) in it, "
                f"e.g. {', '.join(outside[:_LISTED])}",
            )


def path_tokens(text: str, base: str | None, tracked: frozenset[str], directories: frozenset[str]) -> Iterator[str]:
    """Yield the repository paths ``text`` names, resolved against ``base``.

    A token names a tracked file, or a tracked directory when it was written with a ``/`` (so a
    prose word that happens to match a top-level directory is not read as a path). ``base`` is the
    directory the text runs in, ``""`` for the repository root. With ``base`` None the directory is
    built at run time, so no relative token can be attributed and nothing is yielded.
    """
    if base is None:
        return
    for raw in _TOKEN_SEPARATORS.split(text):
        if not raw or "://" in raw:
            continue
        token = raw
        while token.startswith("./"):
            token = token[2:]
        # Decide "written as a path" BEFORE trimming, so `ls release/` still names a directory.
        written_as_path = "/" in token
        token = token.rstrip(".:/")
        if not token or token.startswith("/") or any(character in token for character in "${}*"):
            continue
        resolved = posixpath.normpath(f"{base}/{token}" if base else token)
        if resolved in (".", "..") or resolved.startswith("../"):
            continue
        if resolved in tracked:
            yield resolved
        elif written_as_path and resolved in directories:
            yield resolved


def _job_texts(job: Mapping[str, object]) -> list[TextAt]:
    """Every string a job's non-ci-lanes steps read, with the directory its relative paths resolve in.

    A ``run:`` script resolves against the step's ``working-directory``, else the job's
    ``defaults.run.working-directory``, else the repository root. Inputs, environment values and
    working-directory values themselves are repository-root relative.
    """
    default_directory = _mapping(_mapping(job.get("defaults")).get("run")).get("working-directory")
    texts: list[TextAt] = [(text, "") for text in _strings(job.get("env"))]
    texts += [(text, "") for text in _strings(job.get("defaults"))]
    for step in _steps(job):
        if _is_action_step(step):
            continue
        for key in _ROOT_RELATIVE_STEP_KEYS:
            texts += [(text, "") for text in _strings(step.get(key))]
        run = step.get("run")
        if isinstance(run, str):
            texts.append((run, _static_directory(step.get("working-directory", default_directory))))
    return texts


def _static_directory(value: object) -> str | None:
    """The repository-relative directory ``value`` names: ``""`` for the root, None if not static."""
    if value is None:
        return ""
    if not isinstance(value, str) or "$" in value:
        return None
    stripped = value.strip()
    if stripped.startswith("/"):
        return None
    normalized = posixpath.normpath(stripped) if stripped else "."
    if normalized == ".":
        return ""
    if normalized == ".." or normalized.startswith("../"):
        return None
    return normalized


def _has_full_history_checkout(steps: Iterable[Mapping[str, object]]) -> bool:
    for step in steps:
        uses = step.get("uses")
        if isinstance(uses, str) and uses.startswith("actions/checkout@"):
            if _mapping(step.get("with")).get("fetch-depth") in (0, "0"):
                return True
    return False


def _lane_references(job: Mapping[str, object]) -> set[tuple[str, str]]:
    return {
        (match.group("planner"), match.group("lane"))
        for text in _strings(job)
        for match in LANE_REFERENCE.finditer(text)
    }


def _is_action_step(step: Mapping[str, object]) -> bool:
    uses = step.get("uses")
    return isinstance(uses, str) and ACTION_REFERENCE.fullmatch(uses.strip()) is not None


def _needs(job: Mapping[str, object]) -> tuple[str, ...]:
    value = job.get("needs", [])
    if isinstance(value, str):
        return (value,)
    if isinstance(value, list):
        return tuple(str(item) for item in value if isinstance(item, str))
    return ()


def _steps(job: Mapping[str, object]) -> list[dict[str, object]]:
    value = job.get("steps")
    if not isinstance(value, list):
        return []
    return [_mapping(step) for step in value if isinstance(step, dict)]


def _mapping(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        return {}
    return {str(key): item for key, item in value.items()}


def _strings(value: object) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def _directories(files: frozenset[str]) -> frozenset[str]:
    directories: set[str] = set()
    for path in files:
        parts = path.split("/")
        for depth in range(1, len(parts)):
            directories.add("/".join(parts[:depth]))
    return frozenset(directories)
