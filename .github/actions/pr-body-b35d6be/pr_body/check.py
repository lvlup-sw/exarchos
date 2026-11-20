"""The pull-request body rules, and the template they read.

The template is the policy. Its ATX headings, in order, are the only headings a body may carry.
The rules, each with its own location in the output:

  1. ``headings``: every template heading is present once, at the same level, in the same order
     (text compared without case). Any other heading is a sixth heading and is refused.
  2. ``empty-section``: a template section with no text says ``None.`` instead.
  3. ``html-comment``: no HTML comment is left in the body. The template hints are comments.
  4. ``footer``: no line starts with "Generated with" or "Made with".
  5. ``word-cap``: the body holds at most ``max_words`` words. 0 turns the cap off.
  6. ``same-as``: each listed file is byte-identical to the template, so a mirror cannot drift.
  7. ``marker``: when a changed path is under a ``marker_paths`` prefix, a body line starts with
     ``marker`` and a non-empty reason.

A template that cannot be read, or that has no heading, is INDETERMINATE: a check with no policy
must never pass.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from .errors import Indeterminate
from .markdown import Heading, Line, comment_lines, headings, prose_lines, sections, visible, word_count

_FOOTER = re.compile(r"^[\W_]*(?:generated|made)\s+with\b", re.IGNORECASE)
_LISTED_PATHS = 10


@dataclass(frozen=True)
class Config:
    template: Path
    same_as: tuple[Path, ...] = ()
    max_words: int = 250
    marker: str = ""
    marker_paths: tuple[str, ...] = ()


@dataclass(frozen=True)
class Finding:
    rule: str
    message: str

    def render(self) -> str:
        return f"{self.rule}: {self.message}"


@dataclass
class Report:
    template_headings: int = 0
    words: int = 0
    marker_paths_touched: int = 0
    violations: list[Finding] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.violations


def load_template(path: Path) -> tuple[str, list[Heading]]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise Indeterminate(f"cannot read the template {path}: {error}") from error
    found = headings(prose_lines(text))
    if not found:
        raise Indeterminate(f"the template {path} has no heading, so there is no policy to check against")
    keys = [(heading.level, heading.key) for heading in found]
    if len(set(keys)) != len(keys):
        raise Indeterminate(f"the template {path} repeats a heading, so the order is ambiguous")
    return text, found


def run_check(config: Config, body: str, changed: Sequence[str] | None = None) -> Report:
    template_text, expected = load_template(config.template)
    lines = prose_lines(body)
    report = Report(template_headings=len(expected), words=word_count(lines))
    report.violations += heading_findings(expected, headings(lines))
    report.violations += empty_section_findings(expected, lines)
    report.violations += [
        Finding("html-comment", f"line {line.number}: an HTML comment is left in the body; delete the template hints")
        for line in comment_lines(lines)
    ]
    report.violations += [
        Finding("footer", f"line {line.number}: a generator footer ({line.text.strip()!r}); delete it")
        for line in visible(lines)
        if _FOOTER.match(line.text)
    ]
    if config.max_words > 0 and report.words > config.max_words:
        report.violations.append(
            Finding("word-cap", f"the body holds {report.words} words; the cap is {config.max_words}")
        )
    report.violations += same_as_findings(config.template, template_text, config.same_as)
    if config.marker:
        touched = touched_paths(changed or (), config.marker_paths)
        report.marker_paths_touched = len(touched)
        report.violations += marker_findings(config.marker, touched, lines)
    return report


def heading_findings(expected: list[Heading], actual: list[Heading]) -> list[Finding]:
    wanted = {(heading.level, heading.key): heading for heading in expected}
    allowed = ", ".join(heading.render() for heading in expected)
    findings: list[Finding] = []
    seen: list[Heading] = []
    for heading in actual:
        key = (heading.level, heading.key)
        if key not in wanted:
            findings.append(
                Finding("headings", f"line {heading.number}: {heading.render()!r} is not a template heading; use only {allowed}")
            )
        elif any((other.level, other.key) == key for other in seen):
            findings.append(Finding("headings", f"line {heading.number}: {heading.render()!r} appears twice"))
        else:
            seen.append(heading)
    present = {(heading.level, heading.key) for heading in seen}
    for heading in expected:
        if (heading.level, heading.key) not in present:
            findings.append(Finding("headings", f"{heading.render()!r} is missing"))
    order = [(heading.level, heading.key) for heading in expected if (heading.level, heading.key) in present]
    if [(heading.level, heading.key) for heading in seen] != order:
        findings.append(
            Finding(
                "headings",
                "the headings are out of order: "
                f"{', '.join(heading.text for heading in seen)}; the order is "
                f"{', '.join(heading.text for heading in expected)}",
            )
        )
    return findings


def empty_section_findings(expected: list[Heading], lines: list[Line]) -> list[Finding]:
    wanted = {(heading.level, heading.key) for heading in expected}
    return [
        Finding("empty-section", f"line {section.heading.number}: {section.heading.text!r} is empty; write None.")
        for section in sections(lines)
        if (section.heading.level, section.heading.key) in wanted and section.is_empty
    ]


def same_as_findings(template: Path, template_text: str, mirrors: Iterable[Path]) -> list[Finding]:
    findings: list[Finding] = []
    for mirror in mirrors:
        try:
            text = mirror.read_text(encoding="utf-8")
        except FileNotFoundError:
            findings.append(Finding("same-as", f"{mirror} does not exist; it must be a copy of {template}"))
            continue
        except (OSError, UnicodeDecodeError) as error:
            raise Indeterminate(f"cannot read {mirror}: {error}") from error
        if text != template_text:
            findings.append(Finding("same-as", f"{mirror} differs from {template}; copy the template over it"))
    return findings


def touched_paths(changed: Iterable[str], prefixes: Sequence[str]) -> list[str]:
    roots = [prefix.strip().strip("/") for prefix in prefixes if prefix.strip().strip("/")]
    result: list[str] = []
    for path in changed:
        normal = path.replace("\\", "/")
        if any(normal == root or normal.startswith(root + "/") for root in roots):
            result.append(normal)
    return result


def marker_findings(marker: str, touched: list[str], lines: list[Line]) -> list[Finding]:
    if not touched or any(_has_marker(marker, line.text) for line in visible(lines)):
        return []
    listed = ", ".join(touched[:_LISTED_PATHS])
    more = f" and {len(touched) - _LISTED_PATHS} more" if len(touched) > _LISTED_PATHS else ""
    return [
        Finding(
            "marker",
            f"the pull request changes {listed}{more}; add a body line that starts with {marker!r} and gives the reason",
        )
    ]


def _has_marker(marker: str, text: str) -> bool:
    stripped = text.lstrip()
    return stripped.startswith(marker) and bool(stripped[len(marker):].strip())
