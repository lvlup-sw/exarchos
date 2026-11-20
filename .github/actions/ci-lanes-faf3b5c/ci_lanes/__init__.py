"""ci-lanes: start only the CI jobs a change can affect, and never let a skip hide a failure.

Modes (``python -m ci_lanes <mode>``):
  plan     decide which lanes a pull request touches and publish them as the ``lanes`` output
  verdict  fail a gate job unless every job it covers succeeded or was licensed to skip
  check    prove the manifest and the workflows that read it still agree (needs PyYAML)

Exit codes: 0 pass, 1 violation, 2 INDETERMINATE (the tool could not see its subject).
"""
