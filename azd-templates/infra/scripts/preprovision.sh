#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Preprovision Hook
# Runs before azd provision to prepare the Terraform environment
# -----------------------------------------------------------------------------
#
# This script:
# 1. Verifies Azure CLI authentication
# 2. Gets the current user's principal ID for RBAC assignments
# 3. Sets up Terraform environment variables (TF_VAR_*)
# 4. Initializes Terraform backend if configured
#
# -----------------------------------------------------------------------------

set -euo pipefail

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

# Determine script and infrastructure directories
SCRIPT_DIR=
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR=
INFRA_DIR="$(dirname "$SCRIPT_DIR")"

# -----------------------------------------------------------------------------
# Helper Functions
# -----------------------------------------------------------------------------

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

# -----------------------------------------------------------------------------
# Azure CLI Authentication Check
# -----------------------------------------------------------------------------

# Verifies the user is authenticated to Azure CLI
# Exits with error if not authenticated
# Outputs: Logs subscription name and ID on success
verify_azure_auth() {
    log_info "Verifying Azure CLI authentication..."

    if ! az account show &>/dev/null; then
        log_error "Not logged in to Azure CLI. Please run 'az login' first."
        exit 1
    fi

    local account_name=
    account_name=$(az account show --query "name" -o tsv)
    local subscription_id=
    subscription_id=$(az account show --query "id" -o tsv)

    log_success "Authenticated to Azure subscription: $account_name ($subscription_id)"
}

# -----------------------------------------------------------------------------
# Get Current User Principal ID
# -----------------------------------------------------------------------------

# Retrieves the principal ID of the current Azure user or service principal
# Returns: Principal ID via stdout, empty string if not found
# Side effects: Logs warnings if principal cannot be determined
get_principal_id() {
    log_info "Retrieving current user principal ID..."

    local principal_id=""

    # Try to get the signed-in user's object ID
    if principal_id=$(az ad signed-in-user show --query "id" -o tsv 2>/dev/null); then
        log_success "User principal ID: $principal_id"
    else
        # Fallback: Try to get service principal if running as SP
        log_warning "Could not get user principal ID. Checking for service principal..."

        local client_id="${ARM_CLIENT_ID:-}"
        if [[ -n "$client_id" ]]; then
            principal_id=$(az ad sp show --id "$client_id" --query "id" -o tsv 2>/dev/null || echo "")
            if [[ -n "$principal_id" ]]; then
                log_success "Service principal ID: $principal_id"
            fi
        fi
    fi

    if [[ -z "$principal_id" ]]; then
        log_warning "Could not determine principal ID. RBAC assignments may fail."
        principal_id=""
    fi

    echo "$principal_id"
}

# -----------------------------------------------------------------------------
# Set Terraform Environment Variables
# -----------------------------------------------------------------------------

# Exports TF_VAR_* environment variables for Terraform
# Reads from azd environment variables (AZURE_ENV_NAME, AZURE_LOCATION, etc.)
# Side effects: Creates .env.terraform file for persistence
set_terraform_vars() {
    log_info "Setting Terraform environment variables..."

    # azd provides these environment variables
    local env_name="${AZURE_ENV_NAME:-dev}"
    local location="${AZURE_LOCATION:-eastus2}"
    local resource_group="${AZURE_RESOURCE_GROUP:-rg-${env_name}}"

    # Get principal ID
    local principal_id=
    principal_id=$(get_principal_id)

    # Export TF_VAR_* variables for Terraform
    export TF_VAR_environment_name="$env_name"
    export TF_VAR_location="$location"
    export TF_VAR_resource_group_name="$resource_group"
    export TF_VAR_principal_id="$principal_id"

    log_success "Terraform variables set:"
    echo "  TF_VAR_environment_name=$env_name"
    echo "  TF_VAR_location=$location"
    echo "  TF_VAR_resource_group_name=$resource_group"
    echo "  TF_VAR_principal_id=${principal_id:0:8}..."

    # Write to .env file for persistence across hook calls
    cat > "$INFRA_DIR/.env.terraform" <<EOF
TF_VAR_environment_name=$env_name
TF_VAR_location=$location
TF_VAR_resource_group_name=$resource_group
TF_VAR_principal_id=$principal_id
EOF

    log_info "Variables saved to $INFRA_DIR/.env.terraform"
}

# -----------------------------------------------------------------------------
# Initialize Terraform Backend
# -----------------------------------------------------------------------------

# Initializes Terraform with remote backend if configured
# Requires: AZURE_TFSTATE_STORAGE_ACCOUNT environment variable for remote state
# Side effects: Runs terraform init, creates temporary config file
init_terraform_backend() {
    log_info "Checking Terraform backend configuration..."

    local backend_config="$INFRA_DIR/provider.conf.json"

    # Check if backend storage account variables are set
    # Remote backend is OPTIONAL - local state is the default when not configured
    if [[ -z "${AZURE_TFSTATE_STORAGE_ACCOUNT:-}" ]] || [[ -z "${AZURE_TFSTATE_RESOURCE_GROUP:-}" ]]; then
        log_info "Remote backend not configured. Using local Terraform state (default)."
        log_info ""
        log_info "To enable remote state with Azure AD authentication:"
        log_info "  1. Run: ./scripts/setup-backend.sh"
        log_info "  2. Set variables via: azd env set AZURE_TFSTATE_STORAGE_ACCOUNT <name>"
        log_info "                        azd env set AZURE_TFSTATE_RESOURCE_GROUP <rg>"
        log_info ""
        log_info "Remote backend uses use_azuread_auth for passwordless authentication."
        return 0
    fi

    if [[ ! -f "$backend_config" ]]; then
        log_warning "Backend config file not found: $backend_config"
        return 0
    fi

    log_info "Initializing Terraform with remote backend..."

    # Check if envsubst is available
    if ! command -v envsubst &> /dev/null; then
        log_warning "envsubst not found. Using backend config without variable substitution."
        log_info "Install gettext package to enable variable substitution (apt-get install gettext)"
        # Use original config file without substitution
        local temp_config="$backend_config"
    else
        # Substitute environment variables in provider.conf.json
        local temp_config=
        temp_config=$(mktemp)
        trap 'rm -f "$temp_config"' RETURN
        envsubst < "$backend_config" > "$temp_config"
    fi

    # Run terraform init
    cd "$INFRA_DIR"
    terraform init -backend-config="$temp_config" -reconfigure

    # Note: temp file cleanup is handled by trap when envsubst was used

    log_success "Terraform backend initialized"
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
    echo ""
    echo "=============================================="
    echo "  azd Preprovision Hook"
    echo "=============================================="
    echo ""

    verify_azure_auth
    set_terraform_vars
    init_terraform_backend

    echo ""
    log_success "Preprovision complete. Ready for 'azd provision'."
    echo ""
}

main "$@"
