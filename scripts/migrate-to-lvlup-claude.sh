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
        -h|--help)
            echo "Usage: $0 [--dry-run]"
            echo ""
            echo "Options:"
            echo "  --dry-run  Show what would be done without making changes"
            echo "  -h, --help Show this help message"
            exit 0
            ;;
        *)
            echo "Error: Unknown argument: $1" >&2
            echo "Use --help for usage information" >&2
            exit 1
            ;;
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
INTERMEDIATE_DIR="$HOME/Documents/code/lvlup-claude"
NEW_DIR="$HOME/Documents/code/lvlup-sw/lvlup-claude"
CLAUDE_DIR="$HOME/.claude"

# Detect the source directory (claude-config, intermediate lvlup-claude, or final location)
detect_source_dir() {
    if [[ -d "$NEW_DIR" ]]; then
        info "Found target directory: lvlup-sw/lvlup-claude (already migrated)"
        echo "$NEW_DIR"
        return 0
    elif [[ -d "$INTERMEDIATE_DIR" ]]; then
        info "Found intermediate directory: lvlup-claude (needs relocation to lvlup-sw/)"
        echo "$INTERMEDIATE_DIR"
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

    # If source is already at final location, skip
    if [[ "$source_dir" == "$NEW_DIR" ]]; then
        info "Target lvlup-sw/lvlup-claude already exists, skipping creation"
        return 0
    fi

    # If source is intermediate location, we'll use mv, so just create parent
    if [[ "$source_dir" == "$INTERMEDIATE_DIR" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
            info "[DRY-RUN] Would create parent directory: $(dirname "$NEW_DIR")"
        else
            mkdir -p "$(dirname "$NEW_DIR")"
            info "Created parent directory: $(dirname "$NEW_DIR")"
        fi
        return 0
    fi

    # For claude-config migration, create full target directory
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

    # If source is already at final location, skip
    if [[ "$source_dir" == "$NEW_DIR" ]]; then
        info "Already at lvlup-sw/lvlup-claude, skipping file migration"
        return 0
    fi

    # For intermediate location, use mv (relocate entire directory)
    if [[ "$source_dir" == "$INTERMEDIATE_DIR" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
            info "[DRY-RUN] Would move $source_dir to $NEW_DIR"
        else
            # Create parent directory
            mkdir -p "$(dirname "$NEW_DIR")"
            # Move the entire directory
            if mv "$source_dir" "$NEW_DIR"; then
                info "Moved $source_dir to $NEW_DIR"
            else
                error "Failed to move $source_dir to $NEW_DIR"
            fi
        fi
        return 0
    fi

    # For claude-config, copy files
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
            # Create parent directory
            mkdir -p "$(dirname "$NEW_DIR")"
            # Copy all files preserving structure
            if ! cp -r "$source_dir"/* "$NEW_DIR"/ 2>/dev/null; then
                # Check if directory was empty (not an error)
                if [[ -z "$(ls -A "$source_dir" 2>/dev/null)" ]]; then
                    warn "Source directory is empty, nothing to copy"
                else
                    error "Failed to copy files from $source_dir to $NEW_DIR"
                fi
            else
                info "Migrated files from $source_dir to $NEW_DIR"
            fi
        fi
    fi
}

# Update symlinks in ~/.claude/ to point to new location
update_symlinks() {
    local source_dir="$1"

    # If source is already at final location, check symlinks point correctly
    if [[ "$source_dir" == "$NEW_DIR" ]]; then
        info "Checking symlinks already point to lvlup-sw/lvlup-claude"
        return 0
    fi

    if [[ ! -d "$CLAUDE_DIR" ]]; then
        warn "~/.claude directory does not exist, skipping symlink update"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Would update symlinks in $CLAUDE_DIR"
        # Find symlinks pointing to old locations
        while IFS= read -r -d '' link; do
            local target new_target
            target=$(readlink "$link" 2>/dev/null || echo "")
            new_target=""

            # Handle claude-config -> lvlup-sw/lvlup-claude
            if [[ "$target" == *"claude-config"* ]]; then
                new_target="${target/claude-config/lvlup-sw\/lvlup-claude}"
            # Handle Documents/code/lvlup-claude -> Documents/code/lvlup-sw/lvlup-claude
            elif [[ "$target" == *"Documents/code/lvlup-claude"* && "$target" != *"lvlup-sw"* ]]; then
                new_target="${target/Documents\/code\/lvlup-claude/Documents\/code\/lvlup-sw\/lvlup-claude}"
            fi

            if [[ -n "$new_target" ]]; then
                info "[DRY-RUN] Would update symlink: $link -> $new_target"
            fi
        done < <(find "$CLAUDE_DIR" -maxdepth 1 -type l -print0 2>/dev/null)
    else
        # Update symlinks
        while IFS= read -r -d '' link; do
            local target new_target
            target=$(readlink "$link" 2>/dev/null || echo "")
            new_target=""

            # Handle claude-config -> lvlup-sw/lvlup-claude
            if [[ "$target" == *"claude-config"* ]]; then
                new_target="${target/claude-config/lvlup-sw\/lvlup-claude}"
            # Handle Documents/code/lvlup-claude -> Documents/code/lvlup-sw/lvlup-claude
            elif [[ "$target" == *"Documents/code/lvlup-claude"* && "$target" != *"lvlup-sw"* ]]; then
                new_target="${target/Documents\/code\/lvlup-claude/Documents\/code\/lvlup-sw\/lvlup-claude}"
            fi

            if [[ -n "$new_target" ]]; then
                # Use ln -sfn for atomic symlink replacement (no separate rm needed)
                ln -sfn "$new_target" "$link"
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
