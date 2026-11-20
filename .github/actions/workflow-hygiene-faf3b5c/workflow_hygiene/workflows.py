"""Find and read a repository's workflow files, and answer the questions the rules ask of them.

Every read fails closed. No workflow directory, zero workflow files, a file that is not valid YAML,
a duplicate mapping key, a missing ``on:`` or a missing ``jobs:`` is INDETERMINATE (exit 2): the
tool cannot vouch for a tree it could not read.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import yaml

from .errors import Indeterminate

WORKFLOW_DIRECTORY = ".github/workflows"
WORKFLOW_SUFFIXES = (".yml", ".yaml")
PULL_REQUEST_EVENTS = frozenset({"pull_request", "pull_request_target"})
_EXPRESSION = re.compile(r"\$\{\{(?P<body>.*)\}\}", re.DOTALL)


@dataclass(frozen=True)
class Workflow:
    name: str
    events: frozenset[str]
    concurrency: object
    jobs: Mapping[str, object]

    @property
    def runs_on_pull_requests(self) -> bool:
        return not self.events.isdisjoint(PULL_REQUEST_EVENTS)


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


def discover(root: Path) -> list[Path]:
    """Every workflow file GitHub would read: the top level of ``.github/workflows``, sorted by name."""
    directory = root / WORKFLOW_DIRECTORY
    if not directory.is_dir():
        raise Indeterminate(f"{directory} is not a directory, so there are no workflows to check")
    files = sorted(
        (path for path in directory.iterdir() if path.is_file() and path.suffix in WORKFLOW_SUFFIXES),
        key=lambda path: path.name,
    )
    if not files:
        raise Indeterminate(f"{directory} holds zero *.yml or *.yaml files, so nothing was checked")
    return files


def load_workflow(path: Path) -> Workflow:
    name = path.name
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise Indeterminate(f"cannot read {name}: {error}") from error
    try:
        document = yaml.load(text, Loader=_UniqueKeyLoader)  # noqa: S506 - SafeLoader subclass
    except yaml.YAMLError as error:
        raise Indeterminate(f"{name} is not valid YAML: {error}") from error
    if not isinstance(document, dict):
        raise Indeterminate(f"{name} is not a YAML mapping")
    jobs = document.get("jobs")
    if not isinstance(jobs, dict) or not jobs:
        raise Indeterminate(f"{name} has no jobs mapping")
    return Workflow(
        name=name,
        events=triggers(name, document),
        concurrency=document.get("concurrency"),
        jobs={str(key): value for key, value in jobs.items()},
    )


def triggers(name: str, document: Mapping[object, object]) -> frozenset[str]:
    """The event names in ``on:``, in its string, list or mapping form.

    YAML 1.1 reads a bare ``on`` key as the boolean ``True``, so PyYAML stores ``on:`` under
    ``True``. A quoted ``"on":`` stays a string. Both spellings are read.
    """
    if "on" in document:
        value = document["on"]
    elif True in document:
        value = document[True]
    else:
        raise Indeterminate(f"{name} has no on: trigger")
    if isinstance(value, str):
        return frozenset({value})
    if isinstance(value, list) and value and all(isinstance(item, str) for item in value):
        return frozenset(str(item) for item in value)
    if isinstance(value, dict) and value and all(isinstance(key, str) for key in value):
        return frozenset(str(key) for key in value)
    raise Indeterminate(f"{name}: on: must be an event name, a list of event names or a mapping, got {value!r}")


def cancels_in_progress(concurrency: object) -> bool:
    """True when a ``concurrency`` value cancels superseded runs.

    Truthy means ``true``, the string ``'true'``, or a ``${{ ... }}`` expression (such as
    ``${{ github.event_name == 'pull_request' }}``). An expression whose body is the literal
    ``false`` is not truthy. The string form ``concurrency: <group>`` never cancels.
    """
    if not isinstance(concurrency, dict):
        return False
    value = concurrency.get("cancel-in-progress")
    if value is True:
        return True
    if not isinstance(value, str):
        return False
    text = value.strip()
    if text == "true":
        return True
    match = _EXPRESSION.fullmatch(text)
    return match is not None and match.group("body").strip() not in ("", "false")
