"""GitHub Actions workflow commands and file commands."""

from __future__ import annotations

import os

from .errors import Indeterminate


def _escape_data(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _escape_property(value: str) -> str:
    return _escape_data(value).replace(":", "%3A").replace(",", "%2C")


def annotate(level: str, title: str, message: str) -> None:
    print(f"::{level} title={_escape_property(title)}::{_escape_data(message)}", flush=True)


def _append(variable: str, text: str) -> None:
    target = os.environ.get(variable, "")
    if not target:
        # Outside Actions (a local dry run) there is nowhere to publish. Inside Actions a missing
        # file command means the result would silently not reach the jobs that read it.
        if os.environ.get("GITHUB_ACTIONS") == "true":
            raise Indeterminate(f"{variable} is not set inside GitHub Actions, so the result cannot be published")
        return
    try:
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(text)
    except OSError as error:
        raise Indeterminate(f"cannot write {variable}: {error}") from error


def set_output(name: str, value: str) -> None:
    if "\n" in value or "\r" in value:
        raise Indeterminate(f"output {name} must be a single line")
    _append("GITHUB_OUTPUT", f"{name}={value}\n")


def append_summary(markdown: str) -> None:
    _append("GITHUB_STEP_SUMMARY", markdown if markdown.endswith("\n") else markdown + "\n")
