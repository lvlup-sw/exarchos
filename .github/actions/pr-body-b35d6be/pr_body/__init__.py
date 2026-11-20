"""pr-body: refuse a pull-request body that does not follow the repository's template.

Usage::

  python -m pr_body --template FILE (--event-file FILE | --body-file FILE) [--root DIR]
                    [--same-as FILE ...] [--max-words N] [--skip-authors LOGIN ...]
                    [--marker TEXT --marker-paths PREFIX ... [--changed-files-file FILE]]

The template's headings are the policy: the body carries them all, in order, and no other
heading. It also refuses an empty section, a leftover HTML comment, a "Generated with" footer
and a body over the word cap. See ``check.py`` for each rule.

Exit codes: 0 pass (or a skipped author), 1 violation, 2 INDETERMINATE (the tool could not see
its subject: no template heading, no pull request in the event, a failed git diff).
"""
