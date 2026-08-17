---
alwaysApply: true
---

# rm Safety

**NEVER:** `rm -rf /`, `rm -rf ~`, `rm -rf .` in home/root, rm with unset variables (`$UNSET_VAR/*`)

**Always:** Use specific paths, `ls` before deleting, avoid `-f` unless needed, verify `-r` targets. When uncertain, preview with `echo rm ...` or ask the user.
