"""The two workflow-hygiene rules, and how exemptions apply to them.

Rule 1 (location ``<workflow-file>:*``): a workflow triggered by ``pull_request`` or
``pull_request_target`` cancels superseded runs. It carries ``concurrency`` with a truthy
``cancel-in-progress`` at workflow level, or every one of its jobs does. Without it, each push to a
pull request starts a full new run while the old one keeps billing minutes.

Rule 2 (location ``<workflow-file>:<job>``): every job that is not a reusable-workflow call sets
``timeout-minutes`` to a positive number or an expression. Without it, a hung job runs for
GitHub's 360-minute default. A reusable-workflow call (job-level ``uses:``) cannot set
``timeout-minutes``; the called workflow's own jobs are checked where they are defined.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .exemptions import CONFIG_PATH, WORKFLOW_WIDE, Exemptions, load_exemptions
from .workflows import PULL_REQUEST_EVENTS, Workflow, cancels_in_progress, discover, load_workflow


@dataclass(frozen=True)
class Finding:
    location: str
    message: str

    def render(self) -> str:
        return f"{self.location}: {self.message}"


@dataclass
class Report:
    workflows: int = 0
    jobs: int = 0
    violations: list[Finding] = field(default_factory=list)
    exempted: list[tuple[Finding, str]] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.violations


def run_check(root: Path) -> Report:
    workflows = [load_workflow(path) for path in discover(root)]
    exemptions = load_exemptions(root)
    report = Report(workflows=len(workflows), jobs=sum(len(workflow.jobs) for workflow in workflows))

    findings: list[Finding] = []
    for workflow in workflows:
        findings += concurrency_findings(workflow)
        findings += timeout_findings(workflow)

    used: set[str] = set()
    for finding in findings:
        exemption = exemptions.entries.get(finding.location)
        if exemption is None:
            report.violations.append(finding)
        else:
            used.add(exemption.key)
            report.exempted.append((finding, exemption.reason))

    report.violations += exemption_findings(exemptions, workflows, used)
    return report


def concurrency_findings(workflow: Workflow) -> list[Finding]:
    if not workflow.runs_on_pull_requests or cancels_in_progress(workflow.concurrency):
        return []
    uncovered = [
        job_id
        for job_id, job in workflow.jobs.items()
        if not (isinstance(job, dict) and cancels_in_progress(job.get("concurrency")))
    ]
    if not uncovered:
        return []
    events = ", ".join(sorted(workflow.events & PULL_REQUEST_EVENTS))
    return [
        Finding(
            f"{workflow.name}:{WORKFLOW_WIDE}",
            f"runs on {events}, but no concurrency with a truthy cancel-in-progress covers it at workflow level "
            f"or on job(s) {', '.join(uncovered)}, so a superseded run keeps running",
        )
    ]


def timeout_findings(workflow: Workflow) -> list[Finding]:
    findings: list[Finding] = []
    for job_id, job in workflow.jobs.items():
        location = f"{workflow.name}:{job_id}"
        if not isinstance(job, dict):
            findings.append(Finding(location, "the job is not a mapping"))
            continue
        if isinstance(job.get("uses"), str):
            continue
        if "timeout-minutes" not in job:
            findings.append(Finding(location, "has no timeout-minutes, so a hung job runs for the 360-minute default"))
        elif not _valid_timeout(job["timeout-minutes"]):
            findings.append(
                Finding(location, f"timeout-minutes must be a positive number or an expression, got {job['timeout-minutes']!r}")
            )
    return findings


def exemption_findings(exemptions: Exemptions, workflows: list[Workflow], used: set[str]) -> list[Finding]:
    by_name = {workflow.name: workflow for workflow in workflows}
    findings = [Finding(f"{CONFIG_PATH}:{key}", message) for key, message in exemptions.problems]
    for key, exemption in exemptions.entries.items():
        if key in used:
            continue
        workflow = by_name.get(exemption.workflow)
        if workflow is None:
            reason = f"workflow {exemption.workflow} does not exist"
        elif exemption.job != WORKFLOW_WIDE and exemption.job not in workflow.jobs:
            reason = f"job {exemption.job} does not exist in {exemption.workflow}"
        else:
            reason = "it matches no violation"
        findings.append(Finding(f"{CONFIG_PATH}:{key}", f"stale exemption: {reason}; delete it"))
    return findings


def _valid_timeout(value: object) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return value > 0
    return isinstance(value, str) and value.strip().startswith("${{") and value.strip().endswith("}}")
