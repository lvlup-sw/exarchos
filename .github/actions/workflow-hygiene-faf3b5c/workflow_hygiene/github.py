"""GitHub Actions workflow commands."""

from __future__ import annotations

import os


def _escape_data(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _escape_property(value: str) -> str:
    return _escape_data(value).replace(":", "%3A").replace(",", "%2C")


def in_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS") == "true"


def annotate(level: str, title: str, message: str) -> None:
    print(f"::{level} title={_escape_property(title)}::{_escape_data(message)}", flush=True)
