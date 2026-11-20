"""Command-line entry point: ``python -m pr_body``. See the package docstring for the flags."""

from __future__ import annotations

import argparse
import sys
import traceback
from collections.abc import Sequence
from pathlib import Path

from .check import Config, Report, run_check
from .errors import EXIT_INDETERMINATE, EXIT_PASS, EXIT_VIOLATION, Indeterminate
from .event import changed_paths, load_pull_request
from .github import annotate, in_actions

TITLE = "pr-body"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pr_body", description=__doc__)
    parser.add_argument("--root", default=".", help="repository root; relative template paths resolve here (default: .)")
    parser.add_argument("--template", required=True, help="the pull-request template whose headings are the policy")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--event-file", help="the GitHub Actions event JSON (GITHUB_EVENT_PATH)")
    source.add_argument("--body-file", help="a file that holds the body, for a local run")
    parser.add_argument("--same-as", action="append", default=[], help="files that must be byte-identical to the template")
    parser.add_argument("--max-words", default="250", help="the most words the body may hold; 0 turns the cap off")
    parser.add_argument("--skip-authors", action="append", default=[], help="pull-request authors the check skips")
    parser.add_argument("--marker", default="", help="a line prefix the body must carry when a marker path changes")
    parser.add_argument("--marker-paths", action="append", default=[], help="path prefixes that require the marker")
    parser.add_argument("--changed-files-file", help="one changed path per line, instead of git diff base...head")
    args = parser.parse_args(argv)
    try:
        return _run(args)
    except Indeterminate as error:
        print(f"{TITLE} INDETERMINATE: {error}", flush=True)
        if in_actions():
            annotate("error", f"{TITLE} INDETERMINATE", str(error))
        return EXIT_INDETERMINATE
    except Exception:  # noqa: BLE001 - an unexpected failure must block, never pass
        traceback.print_exc()
        if in_actions():
            annotate("error", f"{TITLE} INDETERMINATE", "unexpected internal error; see the log above")
        return EXIT_INDETERMINATE


def _run(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    if not root.is_dir():
        raise Indeterminate(f"the root {root} is not a directory")
    marker = str(args.marker).strip()
    marker_paths = _words(args.marker_paths)
    if bool(marker) != bool(marker_paths):
        raise Indeterminate("set marker and marker-paths together, or neither")
    config = Config(
        template=_under(root, str(args.template)),
        same_as=tuple(_under(root, path) for path in _words(args.same_as)),
        max_words=_max_words(str(args.max_words)),
        marker=marker,
        marker_paths=marker_paths,
    )

    changed: tuple[str, ...] | None = None
    if args.changed_files_file:
        changed = tuple(line.strip() for line in _read(Path(args.changed_files_file)).splitlines() if line.strip())
    if args.event_file:
        pull = load_pull_request(Path(args.event_file))
        if pull.author in _words(args.skip_authors):
            print(f"{TITLE}: SKIP, the author {pull.author} is in skip-authors", flush=True)
            return EXIT_PASS
        body = pull.body
        if marker and changed is None:
            changed = changed_paths(root, pull.base_sha, pull.head_sha)
    else:
        body = _read(Path(args.body_file))
        if marker and changed is None:
            raise Indeterminate("a --body-file run with a marker needs --changed-files-file")

    report = run_check(config, body, changed)
    for finding in report.violations:
        print(finding.render(), flush=True)
        if in_actions():
            annotate("error", TITLE, finding.render())
    print(_summary(report, config), flush=True)
    return EXIT_PASS if report.passed else EXIT_VIOLATION


def _summary(report: Report, config: Config) -> str:
    status = "PASS" if report.passed else f"FAIL ({len(report.violations)} violation(s))"
    cap = f"cap {config.max_words}" if config.max_words > 0 else "no cap"
    text = f"{TITLE}: {status} over {report.template_headings} template heading(s), {report.words} word(s) ({cap})"
    if config.same_as:
        text += f", {len(config.same_as)} mirror(s)"
    if config.marker:
        text += f", {report.marker_paths_touched} marker path(s) changed"
    return text


def _words(values: Sequence[str]) -> tuple[str, ...]:
    return tuple(word for value in values for word in str(value).split())


def _under(root: Path, path: str) -> Path:
    candidate = Path(path)
    return candidate if candidate.is_absolute() else root / candidate


def _max_words(value: str) -> int:
    try:
        number = int(value.strip())
    except ValueError as error:
        raise Indeterminate(f"max-words must be a whole number, got {value!r}") from error
    if number < 0:
        raise Indeterminate(f"max-words must not be negative, got {number}")
    return number


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise Indeterminate(f"cannot read {path}: {error}") from error


if __name__ == "__main__":
    sys.exit(main())
