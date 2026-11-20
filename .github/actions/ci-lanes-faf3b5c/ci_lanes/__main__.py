"""Command-line entry point: ``python -m ci_lanes {plan,verdict,check}``."""

from __future__ import annotations

import argparse
import os
import sys
import traceback
from collections.abc import Callable, Sequence
from pathlib import Path

from .errors import EXIT_INDETERMINATE, EXIT_PASS, EXIT_VIOLATION, Indeterminate
from .github import annotate, append_summary, set_output
from .manifest import DEFAULT_MANIFEST, is_repo_relative, load_manifest
from .plan import changed_paths, plan_for_event, render_plan
from .verdict import evaluate, render_verdict


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    handler: Callable[[argparse.Namespace], int] = args.handler
    try:
        return handler(args)
    except Indeterminate as error:
        annotate("error", f"ci-lanes {args.mode} INDETERMINATE", str(error))
        return EXIT_INDETERMINATE
    except Exception:  # noqa: BLE001 - an unexpected failure must block, never pass
        traceback.print_exc()
        annotate("error", f"ci-lanes {args.mode} INDETERMINATE", "unexpected internal error; see the log above")
        return EXIT_INDETERMINATE


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ci_lanes", description=__doc__)
    subparsers = parser.add_subparsers(dest="mode", required=True)

    def common(sub: argparse.ArgumentParser) -> None:
        sub.add_argument("--repo", default=".", help="repository root (default: the working directory)")
        sub.add_argument("--manifest", default=DEFAULT_MANIFEST, help=f"repository-relative manifest (default: {DEFAULT_MANIFEST})")

    plan = subparsers.add_parser("plan", help="decide which lanes a change touches")
    common(plan)
    plan.add_argument("--event", help="event name (default: $GITHUB_EVENT_NAME)")
    plan.add_argument("--base", help="pull request base SHA (default: $CI_LANES_BASE_SHA)")
    plan.add_argument("--head", help="pull request head SHA (default: $CI_LANES_HEAD_SHA)")
    plan.add_argument("--files-from", help="read changed paths from this file instead of git (dry runs)")
    plan.add_argument("--lane", default="", help="also publish `relevant` for this one lane")
    plan.set_defaults(handler=_run_plan)

    verdict = subparsers.add_parser("verdict", help="decide whether a gate job passes")
    common(verdict)
    verdict.add_argument("--gate", required=True, help="the gate's job id, as declared in the manifest")
    verdict.add_argument("--needs-json", help="the gate's toJSON(needs) (default: $CI_LANES_NEEDS)")
    verdict.set_defaults(handler=_run_verdict)

    check = subparsers.add_parser("check", help="prove the manifest and its workflows agree")
    common(check)
    check.set_defaults(handler=_run_check)
    return parser


def _run_plan(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    manifest = load_manifest(repo, args.manifest)
    event = args.event if args.event is not None else os.environ.get("GITHUB_EVENT_NAME", "")
    lane = str(args.lane)
    if lane and lane not in manifest.lanes:
        raise Indeterminate(f"--lane {lane!r} is not declared in {manifest.path}")
    changed: tuple[str, ...] | None = None
    if event == "pull_request":
        if args.files_from is not None:
            changed = _read_files(Path(args.files_from))
        else:
            base = args.base if args.base is not None else os.environ.get("CI_LANES_BASE_SHA", "")
            head = args.head if args.head is not None else os.environ.get("CI_LANES_HEAD_SHA", "")
            changed = changed_paths(repo, base, head)
    result = plan_for_event(manifest, event, changed)
    print(render_plan(result, markdown=False), flush=True)
    append_summary(render_plan(result, markdown=True))
    set_output("lanes", result.lanes_json())
    if lane:
        set_output("relevant", "true" if result.relevant(lane) else "false")
    return EXIT_PASS


def _run_verdict(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    manifest = load_manifest(repo, args.manifest)
    needs_json = args.needs_json if args.needs_json is not None else os.environ.get("CI_LANES_NEEDS", "")
    result = evaluate(manifest, str(args.gate), needs_json)
    print(render_verdict(result, markdown=False), flush=True)
    append_summary(render_verdict(result, markdown=True))
    if not result.passed:
        annotate("error", f"ci-lanes gate {result.gate}", "a covered job failed, or skipped without a licence; see the summary")
        return EXIT_VIOLATION
    return EXIT_PASS


def _run_check(args: argparse.Namespace) -> int:
    from .check import run_check  # PyYAML is imported only by this mode

    repo = Path(args.repo).resolve()
    manifest = load_manifest(repo, args.manifest)
    result = run_check(repo, manifest)
    for violation in result.violations:
        annotate("error", "ci-lanes check", violation)
    status = "PASS" if not result.violations else f"FAIL ({len(result.violations)} violation(s))"
    print(f"ci-lanes check {manifest.path}: {status} over {result.assertions} assertion(s)", flush=True)
    return EXIT_PASS if not result.violations else EXIT_VIOLATION


def _read_files(path: Path) -> tuple[str, ...]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise Indeterminate(f"cannot read changed-path list {path}: {error}") from error
    files = tuple(line.strip() for line in lines if line.strip())
    for file in files:
        if not is_repo_relative(file):
            raise Indeterminate(f"changed-path list {path} holds a path that is not repository-relative: {file!r}")
    return files


if __name__ == "__main__":
    sys.exit(main())
