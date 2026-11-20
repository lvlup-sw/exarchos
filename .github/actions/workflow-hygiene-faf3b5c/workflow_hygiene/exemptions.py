"""Load a repository's workflow-hygiene exemptions.

The file is optional and is TOML, so it needs nothing outside the standard library:

    # .github/workflow-hygiene.toml
    [exempt]
    "release.yml:publish" = "the registry publish has its own retry budget; a job timeout would cut it mid-upload"
    "deploy.yml:*" = "a started deploy must finish; a newer run queues behind it instead of cancelling it"

A key is ``<workflow-file>:<job>`` (the job may skip ``timeout-minutes``) or ``<workflow-file>:*``
(the workflow may skip the pull-request concurrency rule). The two never stand in for each other.

A key that does not parse, an empty reason, and a key that matches no violation are violations
(exit 1): a stale exemption is cover for the next job that drifts. A file that is not valid TOML,
or holds any table but ``[exempt]``, is INDETERMINATE (exit 2): a misspelled table must not
silently mean "no exemptions" or "different exemptions".
"""

from __future__ import annotations

import re
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from .errors import Indeterminate

CONFIG_PATH = ".github/workflow-hygiene.toml"
WORKFLOW_WIDE = "*"
KEY = re.compile(r"(?P<workflow>[A-Za-z0-9_.-]+\.ya?ml):(?P<job>\*|[A-Za-z_][A-Za-z0-9_-]*)")
_TOP_KEYS = frozenset({"exempt"})


@dataclass(frozen=True)
class Exemption:
    key: str
    workflow: str
    job: str
    reason: str


@dataclass(frozen=True)
class Exemptions:
    entries: Mapping[str, Exemption] = field(default_factory=dict)
    problems: tuple[tuple[str, str], ...] = ()
    """``(key, message)`` for every entry that is itself a violation and exempts nothing."""


def load_exemptions(root: Path) -> Exemptions:
    path = root / CONFIG_PATH
    if not path.exists():
        return Exemptions()
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise Indeterminate(f"cannot read {CONFIG_PATH}: {error}") from error
    try:
        document = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise Indeterminate(f"{CONFIG_PATH} is not valid TOML: {error}") from error
    return parse_exemptions(document)


def parse_exemptions(document: Mapping[str, object]) -> Exemptions:
    unknown = sorted(set(document) - _TOP_KEYS)
    if unknown:
        raise Indeterminate(f"{CONFIG_PATH}: unknown key(s) {', '.join(unknown)}; the only table is [exempt]")
    table = document.get("exempt", {})
    if not isinstance(table, dict):
        raise Indeterminate(f"{CONFIG_PATH}: exempt must be a table of \"<workflow-file>:<job>\" = \"reason\"")
    entries: dict[str, Exemption] = {}
    problems: list[tuple[str, str]] = []
    for key, reason in table.items():
        match = KEY.fullmatch(key)
        if match is None:
            problems.append((key, "an exemption key must be \"<workflow-file>:<job>\" or \"<workflow-file>:*\""))
            continue
        if not isinstance(reason, str) or not reason.strip():
            problems.append((key, "an exemption must state a non-empty reason"))
            continue
        entries[key] = Exemption(key, match.group("workflow"), match.group("job"), reason.strip())
    return Exemptions(entries, tuple(problems))
