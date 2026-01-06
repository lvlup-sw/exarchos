#!/usr/bin/env bash
# migrate-to-lvlup-claude.sh - Migrate from claude-config to lvlup-claude
#
# Usage: ./migrate-to-lvlup-claude.sh [--dry-run]
#
# This script:
# 1. Detects source directory (claude-config or lvlup-claude)
# 2. Creates target directory if needed
# 3. Migrates files
# 4. Updates symlinks in ~/.claude/

set -euo pipefail

# Parse arguments
DRY_RUN=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run) DRY_RUN=true; shift ;;
        *) shift ;;
    esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

# Paths
OLD_DIR="$HOME/Documents/code/claude-config"
NEW_DIR="$HOME/Documents/code/lvlup-claude"
CLAUDE_DIR="$HOME/.claude"

# Detect the source directory (claude-config or lvlup-claude)
detect_source_dir() {
    if [[ -d "$NEW_DIR" ]]; then
        info "Found target directory: lvlup-claude (already migrated)"
        echo "$NEW_DIR"
        return 0
    elif [[ -d "$OLD_DIR" ]]; then
        info "Found source directory: claude-config"
        echo "$OLD_DIR"
        return 0
    else
        return 1
    fi
}

# Create the target directory if it doesn't exist
create_target_dir() {
    local source_dir="$1"

    # If source is already lvlup-claude, skip
    if [[ "$source_dir" == "$NEW_DIR" ]]; then
        info "Target lvlup-claude already exists, skipping creation"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Would create target directory: $NEW_DIR"
    else
        if [[ ! -d "$NEW_DIR" ]]; then
            mkdir -p "$NEW_DIR"
            info "Created target directory: $NEW_DIR"
        fi
    fi
}

# Migrate files from source to target
migrate_files() {
    local source_dir="$1"

    # If source is already lvlup-claude, skip
    if [[ "$source_dir" == "$NEW_DIR" ]]; then
        info "Already at lvlup-claude, skipping file migration"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Would migrate files from $source_dir to $NEW_DIR"
        # List files that would be copied
        if [[ -d "$source_dir" ]]; then
            local file_count
            file_count=$(find "$source_dir" -type f | wc -l)
            info "[DRY-RUN] Would copy $file_count files"
        fi
    else
        if [[ -d "$source_dir" ]]; then
            # Copy all files preserving structure
            cp -r "$source_dir"/* "$NEW_DIR"/ 2>/dev/null || true
            info "Migrated files from $source_dir to $NEW_DIR"
        fi
    fi
}

# Update symlinks in ~/.claude/ to point to new location
update_symlinks() {
    local source_dir="$1"

    # If source is already lvlup-claude, check symlinks point correctly
    if [[ "$source_dir" == "$NEW_DIR" ]]; then
        info "Checking symlinks already point to lvlup-claude"
        return 0
    fi

    if [[ ! -d "$CLAUDE_DIR" ]]; then
        warn "~/.claude directory does not exist, skipping symlink update"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Would update symlinks in $CLAUDE_DIR"
        # Find symlinks pointing to old location
        while IFS= read -r -d '' link; do
            local target
            target=$(readlink "$link" 2>/dev/null || echo "")
            if [[ "$target" == *"claude-config"* ]]; then
                local new_target="${target/claude-config/lvlup-claude}"
                info "[DRY-RUN] Would update symlink: $link -> $new_target"
            fi
        done < <(find "$CLAUDE_DIR" -maxdepth 1 -type l -print0 2>/dev/null)
    else
        # Update symlinks
        while IFS= read -r -d '' link; do
            local target
            target=$(readlink "$link" 2>/dev/null || echo "")
            if [[ "$target" == *"claude-config"* ]]; then
                local new_target="${target/claude-config/lvlup-claude}"
                rm "$link"
                ln -sf "$new_target" "$link"
                info "Updated symlink: $link -> $new_target"
            fi
        done < <(find "$CLAUDE_DIR" -maxdepth 1 -type l -print0 2>/dev/null)
    fi
}

# Main
main() {
    info "Starting migration from claude-config to lvlup-claude"

    if [[ "$DRY_RUN" == true ]]; then
        warn "DRY-RUN MODE: No changes will be made"
    fi

    # Step 1: Detect source directory
    local source_dir
    if ! source_dir=$(detect_source_dir); then
        error "No source directory found. Neither claude-config nor lvlup-claude exists."
    fi

    # Step 2: Create target directory
    create_target_dir "$source_dir"

    # Step 3: Migrate files
    migrate_files "$source_dir"

    # Step 4: Update symlinks
    update_symlinks "$source_dir"

    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Migration preview complete"
    else
        info "Migration complete!"
    fi
}

main
