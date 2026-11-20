"""Command-line entry point: ``python -m workflow_hygiene [--root DIR]``."""

from __future__ import annotations

import argparse
import sys
import traceback
from collections.abc import Sequence
from pathlib import Path

from .check import run_check
from .errors import EXIT_INDETERMINATE, EXIT_PASS, EXIT_VIOLATION, Indeterminate
from .github import annotate, in_actions

TITLE = "workflow-hygiene"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="workflow_hygiene", description=__doc__)
    parser.add_argument("--root", default=".", help="repository root that holds .github/workflows (default: .)")
    args = parser.parse_args(argv)
    try:
        return _run(Path(args.root))
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


def _run(root: Path) -> int:
    report = run_check(root.resolve())
    for finding, reason in report.exempted:
        print(f"exempt: {finding.location}: {reason}", flush=True)
    for finding in report.violations:
        print(finding.render(), flush=True)
        if in_actions():
            annotate("error", TITLE, finding.render())
    status = "PASS" if report.passed else f"FAIL ({len(report.violations)} violation(s))"
    print(
        f"{TITLE}: {status} over {report.workflows} workflow(s), {report.jobs} job(s), "
        f"{len(report.exempted)} exempted",
        flush=True,
    )
    return EXIT_PASS if report.passed else EXIT_VIOLATION


if __name__ == "__main__":
    sys.exit(main())
