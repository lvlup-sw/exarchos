"""Read the pull request from the Actions event file, and its changed paths from the local checkout.

The body comes from the event payload, never from the shell, so no body text can change what a
shell parses. The payload holds the body as it was when the event fired: a re-run of an old job
checks the old body. Edit the body to start a fresh run.

The changed paths come from ``git diff --name-only base...head`` in the checkout, with no token
and no API call. The checkout needs the base commit (``fetch-depth: 0``).
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .errors import Indeterminate


@dataclass(frozen=True)
class PullRequest:
    author: str
    body: str
    base_sha: str
    head_sha: str


def load_pull_request(event_file: Path) -> PullRequest:
    try:
        document = json.loads(event_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise Indeterminate(f"cannot read the event file {event_file}: {error}") from error
    pull = document.get("pull_request") if isinstance(document, dict) else None
    if not isinstance(pull, dict):
        raise Indeterminate("the event has no pull_request; run this check on pull_request events only")
    body = pull.get("body")
    return PullRequest(
        author=_text(pull, "user", "login"),
        body=body if isinstance(body, str) else "",
        base_sha=_text(pull, "base", "sha"),
        head_sha=_text(pull, "head", "sha"),
    )


def changed_paths(root: Path, base_sha: str, head_sha: str) -> tuple[str, ...]:
    if not base_sha or not head_sha:
        raise Indeterminate("the event has no base or head commit, so the changed paths are unknown")
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), "diff", "--name-only", "-z", "--no-renames", f"{base_sha}...{head_sha}"],
            capture_output=True,
            check=False,
        )
    except OSError as error:
        raise Indeterminate(f"git could not start: {error}") from error
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip()
        raise Indeterminate(
            f"git diff {base_sha}...{head_sha} failed ({completed.returncode}): {detail}. "
            "Check out with fetch-depth: 0 so the base commit is present"
        )
    try:
        return tuple(path for path in completed.stdout.decode("utf-8").split("\0") if path)
    except UnicodeDecodeError as error:
        raise Indeterminate(f"git diff listed a path that is not UTF-8: {error}") from error


def _text(document: dict[str, object], *keys: str) -> str:
    value: object = document
    for key in keys:
        value = value.get(key) if isinstance(value, dict) else None
    return value if isinstance(value, str) else ""
