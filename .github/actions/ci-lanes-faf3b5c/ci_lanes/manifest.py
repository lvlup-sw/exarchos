"""Load and validate a consumer's ci-lanes manifest.

The manifest is TOML, so the planner needs nothing outside the standard library. Every table
refuses unknown keys: a misspelled key is a lane that silently stops meaning what its author
wrote, so it is INDETERMINATE (exit 2), never ignored.

    schema_version = 1
    planner_job = "plan"                     # optional; the job id that runs `plan`

    [lanes.build_test]                       # key: [a-z][a-z0-9_]*, read as fromJSON(...).build_test
    workflows = ["ci.yml"]                   # edits to these workflow files make the lane relevant
    paths = ["src/**", "global.json"]        # globs; see globs.py
    description = "..."                      # optional
    allow_empty = "reason"                   # optional; lets a glob match no tracked file
    exempt_paths = { "README.md" = "why" }   # optional; paths a job names but the lane need not match

    [gates.terraform-gate]                   # key: the gate's job id
    workflow = "terraform.yml"
    jobs = { validate = "terraform" }        # gated job id -> the lane that licenses its skip

    [[fixtures]]                             # replayed by `check`
    name = "docs-only change"
    files = ["README.md"]
    expect = { build_test = false }
"""

from __future__ import annotations

import re
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from .errors import Indeterminate
from .globs import Glob, GlobError, compile_glob

SCHEMA_VERSION = 1
DEFAULT_MANIFEST = ".github/ci-lanes.toml"
DEFAULT_PLANNER_JOB = "plan"

LANE_KEY = re.compile(r"[a-z][a-z0-9_]*")
JOB_ID = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*")
WORKFLOW_FILE = re.compile(r"[A-Za-z0-9_.-]+\.ya?ml")

_TOP_KEYS = frozenset({"schema_version", "planner_job", "lanes", "gates", "fixtures"})
_LANE_KEYS = frozenset({"workflows", "paths", "description", "allow_empty", "exempt_paths"})
_GATE_KEYS = frozenset({"workflow", "jobs"})
_FIXTURE_KEYS = frozenset({"name", "files", "expect"})


@dataclass(frozen=True)
class Lane:
    key: str
    workflows: tuple[str, ...]
    globs: tuple[Glob, ...]
    description: str
    allow_empty: str | None
    exempt_paths: Mapping[str, str]

    @property
    def workflow_paths(self) -> tuple[str, ...]:
        return tuple(f".github/workflows/{name}" for name in self.workflows)

    def matches(self, path: str) -> bool:
        return path in self.workflow_paths or any(glob.matches(path) for glob in self.globs)


@dataclass(frozen=True)
class Gate:
    job: str
    workflow: str
    jobs: Mapping[str, str]


@dataclass(frozen=True)
class Fixture:
    name: str
    files: tuple[str, ...]
    expect: Mapping[str, bool]


@dataclass(frozen=True)
class Manifest:
    path: str
    planner_job: str
    lanes: Mapping[str, Lane]
    gates: Mapping[str, Gate]
    fixtures: tuple[Fixture, ...]


def is_repo_relative(value: str) -> bool:
    if not value or value != value.strip() or "\\" in value:
        return False
    if value.startswith("/") or value.endswith("/"):
        return False
    return all(part not in ("", ".", "..") for part in value.split("/"))


def load_manifest(repo_root: Path, manifest_path: str) -> Manifest:
    if not is_repo_relative(manifest_path):
        raise Indeterminate(f"manifest path must be repository-relative: {manifest_path!r}")
    try:
        text = (repo_root / manifest_path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise Indeterminate(f"cannot read manifest {manifest_path}: {error}") from error
    try:
        document = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise Indeterminate(f"manifest {manifest_path} is not valid TOML: {error}") from error
    return parse_manifest(document, manifest_path)


def parse_manifest(document: Mapping[str, object], manifest_path: str) -> Manifest:
    where = manifest_path
    _refuse_unknown(document, _TOP_KEYS, where)
    version = document.get("schema_version")
    if isinstance(version, bool) or version != SCHEMA_VERSION:
        raise Indeterminate(f"{where}: schema_version must be {SCHEMA_VERSION}, got {version!r}")
    planner_job = _optional_str(document, "planner_job", where) or DEFAULT_PLANNER_JOB
    if JOB_ID.fullmatch(planner_job) is None:
        raise Indeterminate(f"{where}: planner_job {planner_job!r} is not a job id")

    lanes_table = _table(document.get("lanes"), f"{where}: lanes")
    if not lanes_table:
        raise Indeterminate(f"{where}: declares no lanes")
    lanes = {key: _parse_lane(key, value, where) for key, value in lanes_table.items()}

    gates_table = _table(document.get("gates", {}), f"{where}: gates")
    gates = {key: _parse_gate(key, value, lanes, planner_job, where) for key, value in gates_table.items()}
    covered: dict[tuple[str, str], str] = {}
    for gate in gates.values():
        for job in gate.jobs:
            owner = covered.setdefault((gate.workflow, job), gate.job)
            if owner != gate.job:
                raise Indeterminate(f"{where}: {gate.workflow}:{job} is covered by both gate {owner} and gate {gate.job}")
            if job in gates and gates[job].workflow == gate.workflow:
                raise Indeterminate(f"{where}: gate {gate.job} covers {job}, which is itself a gate")

    fixtures = _parse_fixtures(document.get("fixtures", []), lanes, where)
    return Manifest(manifest_path, planner_job, lanes, gates, fixtures)


def _parse_lane(key: str, value: object, where: str) -> Lane:
    label = f"{where}: lanes.{key}"
    if LANE_KEY.fullmatch(key) is None:
        raise Indeterminate(
            f"{label}: a lane key must match {LANE_KEY.pattern} so a workflow can read it as fromJSON(...).{key}"
        )
    table = _table(value, label)
    _refuse_unknown(table, _LANE_KEYS, label)
    workflows = _str_list(table.get("workflows"), f"{label}.workflows")
    for name in workflows:
        if WORKFLOW_FILE.fullmatch(name) is None:
            raise Indeterminate(f"{label}.workflows: {name!r} must be a file name under .github/workflows/")
    patterns = _str_list(table.get("paths"), f"{label}.paths")
    try:
        globs = tuple(compile_glob(pattern) for pattern in patterns)
    except GlobError as error:
        raise Indeterminate(f"{label}.paths: {error}") from error
    description = _optional_str(table, "description", label) or ""
    allow_empty = _optional_str(table, "allow_empty", label)
    exempt: dict[str, str] = {}
    if "exempt_paths" in table:
        for path, reason in _table(table["exempt_paths"], f"{label}.exempt_paths").items():
            if not is_repo_relative(path):
                raise Indeterminate(f"{label}.exempt_paths: {path!r} is not repository-relative")
            if not isinstance(reason, str) or not reason.strip():
                raise Indeterminate(f"{label}.exempt_paths.{path} must state a reason")
            exempt[path] = reason
    return Lane(key, workflows, globs, description, allow_empty, exempt)


def _parse_gate(key: str, value: object, lanes: Mapping[str, Lane], planner_job: str, where: str) -> Gate:
    label = f"{where}: gates.{key}"
    if JOB_ID.fullmatch(key) is None:
        raise Indeterminate(f"{label}: {key!r} is not a job id")
    if key == planner_job:
        raise Indeterminate(f"{label}: a gate cannot be the planner job")
    table = _table(value, label)
    _refuse_unknown(table, _GATE_KEYS, label)
    workflow = _optional_str(table, "workflow", label)
    if workflow is None or WORKFLOW_FILE.fullmatch(workflow) is None:
        raise Indeterminate(f"{label}.workflow must name a file under .github/workflows/")
    jobs_table = _table(table.get("jobs"), f"{label}.jobs")
    if not jobs_table:
        raise Indeterminate(f"{label}.jobs must map at least one job to its lane")
    jobs: dict[str, str] = {}
    for job, lane_key in jobs_table.items():
        if JOB_ID.fullmatch(job) is None or job in (key, planner_job):
            raise Indeterminate(f"{label}.jobs: {job!r} cannot be gated")
        if not isinstance(lane_key, str) or lane_key not in lanes:
            raise Indeterminate(f"{label}.jobs.{job} must name a declared lane")
        if workflow not in lanes[lane_key].workflows:
            raise Indeterminate(f"{label}.jobs.{job}: lane {lane_key} does not list {workflow}")
        jobs[job] = lane_key
    return Gate(key, workflow, jobs)


def _parse_fixtures(value: object, lanes: Mapping[str, Lane], where: str) -> tuple[Fixture, ...]:
    if not isinstance(value, list):
        raise Indeterminate(f"{where}: fixtures must be an array of tables")
    fixtures: list[Fixture] = []
    names: set[str] = set()
    for index, entry in enumerate(value):
        label = f"{where}: fixtures[{index}]"
        table = _table(entry, label)
        _refuse_unknown(table, _FIXTURE_KEYS, label)
        name = _optional_str(table, "name", label)
        if name is None:
            raise Indeterminate(f"{label}: name is required")
        if name in names:
            raise Indeterminate(f"{label}: fixture name {name!r} is used twice")
        names.add(name)
        files = _str_list(table.get("files"), f"{label}.files")
        for path in files:
            if not is_repo_relative(path):
                raise Indeterminate(f"{label}.files: {path!r} is not repository-relative")
        expect_table = _table(table.get("expect"), f"{label}.expect")
        if not expect_table:
            raise Indeterminate(f"{label}.expect must name at least one lane")
        expect: dict[str, bool] = {}
        for lane_key, expected in expect_table.items():
            if lane_key not in lanes:
                raise Indeterminate(f"{label}.expect: {lane_key!r} is not a declared lane")
            if not isinstance(expected, bool):
                raise Indeterminate(f"{label}.expect.{lane_key} must be true or false")
            expect[lane_key] = expected
        fixtures.append(Fixture(name, files, expect))
    return tuple(fixtures)


def _refuse_unknown(table: Mapping[str, object], allowed: frozenset[str], where: str) -> None:
    unknown = sorted(set(table) - allowed)
    if unknown:
        raise Indeterminate(f"{where}: unknown key(s) {', '.join(unknown)}")


def _table(value: object, where: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise Indeterminate(f"{where} must be a table")
    return {str(key): item for key, item in value.items()}


def _str_list(value: object, where: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value:
        raise Indeterminate(f"{where} must be a non-empty array of strings")
    items: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item:
            raise Indeterminate(f"{where} must contain only non-empty strings")
        if item in items:
            raise Indeterminate(f"{where} lists {item!r} twice")
        items.append(item)
    return tuple(items)


def _optional_str(table: Mapping[str, object], key: str, where: str) -> str | None:
    if key not in table:
        return None
    value = table[key]
    if not isinstance(value, str) or not value.strip():
        raise Indeterminate(f"{where}: {key} must be a non-empty string")
    return value
