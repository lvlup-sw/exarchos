---
alwaysApply: true
---

# rm Safety Guidelines

When using `rm` commands, follow these safety practices:

## NEVER Execute

- `rm -rf /` or `rm -rf /*` - destroys entire system
- `rm -rf ~` or `rm -rf ~/*` - destroys home directory
- `rm -rf .` in home or root directories
- Any rm with variables that could expand dangerously (e.g., `rm -rf $UNSET_VAR/*`)

## Always Prefer

1. **Use specific paths** - never use broad wildcards at dangerous locations
2. **List before deleting** - run `ls` first to verify what will be deleted
3. **Use relative paths** - prefer `rm ./file` over absolute paths when possible
4. **Avoid -f flag** - unless specifically needed, let rm prompt for protected files
5. **Double-check recursion** - before `rm -r`, verify the target directory

## Safe Patterns

```bash
# Good: specific file
rm ./temp-file.txt

# Good: specific directory contents
rm -r ./build/

# Good: with confirmation
rm -i ./important-file

# Dangerous: broad wildcard
rm -rf /tmp/*  # Could delete important temp files

# Dangerous: variable expansion
rm -rf "${DIR}/"  # What if DIR is empty or /?
```

## When in Doubt

If uncertain about an rm command's safety:
1. First run with `echo` to see what would be deleted: `echo rm -rf ./path`
2. Or use `ls` to preview: `ls ./path`
3. Ask the user to confirm before executing
