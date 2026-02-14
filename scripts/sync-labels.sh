#!/usr/bin/env bash
# sync-labels.sh - Sync labels from .github/labels.yml to GitHub
#
# Usage: ./scripts/sync-labels.sh [--dry-run]
#
# Requires: gh (GitHub CLI), python3 with pyyaml

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
LABELS_FILE="$REPO_ROOT/.github/labels.yml"

# Auto-detect repository from git remote, environment, or use default
if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    # Use GitHub Actions environment variable
    REPO="$GITHUB_REPOSITORY"
elif command -v gh &> /dev/null && gh repo view --json nameWithOwner -q .nameWithOwner &> /dev/null; then
    # Auto-detect from git remote via gh CLI
    REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
else
    # Fallback to default
    REPO="lvlup-sw/exarchos"
fi

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
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Check dependencies
check_deps() {
    if ! command -v gh &> /dev/null; then
        error "gh (GitHub CLI) is required but not installed"
    fi
    if ! python3 -c "import yaml" &> /dev/null; then
        error "Python yaml module is required. Install with: pip install pyyaml"
    fi
    if [[ ! -f "$LABELS_FILE" ]]; then
        error "Labels file not found: $LABELS_FILE"
    fi
}

# Delete default GitHub labels we don't use
delete_default_labels() {
    local defaults=("duplicate" "enhancement" "good first issue" "help wanted" "invalid" "wontfix" "bug" "documentation" "question")

    info "Removing default labels..."
    for label in "${defaults[@]}"; do
        if [[ "$DRY_RUN" == "true" ]]; then
            echo "  [dry-run] Would delete: $label"
        else
            gh label delete "$label" -R "$REPO" --yes 2>/dev/null && \
                echo "  Deleted: $label" || \
                echo "  Skipped: $label (not found)"
        fi
    done
}

# Create/update labels from config
sync_labels() {
    info "Syncing labels from $LABELS_FILE..."

    # Parse YAML and create labels using Python
    python3 -c "import yaml; [print(f\"{l['name']}|{l['color']}|{l['description']}\") for l in yaml.safe_load(open('$LABELS_FILE'))]" | \
    while IFS='|' read -r name color desc; do
        if [[ "$DRY_RUN" == "true" ]]; then
            echo "  [dry-run] Would create/update: $name ($color) - $desc"
        else
            gh label create "$name" -R "$REPO" --color "$color" --description "$desc" --force 2>/dev/null && \
                echo "  Created/Updated: $name" || \
                echo "  Failed: $name"
        fi
    done
}

# Main
main() {
    echo "Label Sync"
    echo "=========="
    echo ""
    echo "Repository: $REPO"
    echo "Labels file: $LABELS_FILE"
    [[ "$DRY_RUN" == "true" ]] && echo "Mode: DRY RUN"
    echo ""

    check_deps
    delete_default_labels
    echo ""
    sync_labels

    echo ""
    info "Label sync complete!"
}

main
