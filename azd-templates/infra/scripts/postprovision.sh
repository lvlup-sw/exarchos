#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Postprovision Hook
# Runs after azd provision to extract outputs and configure services
# -----------------------------------------------------------------------------
#
# This script:
# 1. Extracts Terraform outputs
# 2. Sets azd environment variables from outputs
# 3. Configures any post-deployment settings
# 4. Verifies provisioned resources
#
# -----------------------------------------------------------------------------

set -euo pipefail

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
# Extract Terraform Outputs
# -----------------------------------------------------------------------------

extract_terraform_outputs() {
    log_info "Extracting Terraform outputs..."

    cd "$INFRA_DIR"

    # Check if terraform state exists
    if ! terraform state list &>/dev/null; then
        log_warning "No Terraform state found. Skipping output extraction."
        return 0
    fi

    # Get outputs as JSON
    local outputs
    outputs=$(terraform output -json 2>/dev/null || echo "{}")

    if [[ "$outputs" == "{}" ]]; then
        log_warning "No Terraform outputs found."
        return 0
    fi

    # Parse and display key outputs
    log_success "Terraform outputs:"

    # Container Registry
    local acr_endpoint
    acr_endpoint=$(echo "$outputs" | jq -r '.AZURE_CONTAINER_REGISTRY_ENDPOINT.value // empty')
    if [[ -n "$acr_endpoint" ]]; then
        echo "  Container Registry: $acr_endpoint"
        azd env set AZURE_CONTAINER_REGISTRY_ENDPOINT "$acr_endpoint" 2>/dev/null || true
    fi

    # Container Apps Environment
    local cae_name
    cae_name=$(echo "$outputs" | jq -r '.AZURE_CONTAINER_APPS_ENVIRONMENT_NAME.value // empty')
    if [[ -n "$cae_name" ]]; then
        echo "  Container Apps Environment: $cae_name"
        azd env set AZURE_CONTAINER_APPS_ENVIRONMENT_NAME "$cae_name" 2>/dev/null || true
    fi

    # Key Vault
    local kv_endpoint
    kv_endpoint=$(echo "$outputs" | jq -r '.AZURE_KEY_VAULT_ENDPOINT.value // empty')
    if [[ -n "$kv_endpoint" ]]; then
        echo "  Key Vault: $kv_endpoint"
        azd env set AZURE_KEY_VAULT_ENDPOINT "$kv_endpoint" 2>/dev/null || true
    fi

    # Resource Group
    local rg_name
    rg_name=$(echo "$outputs" | jq -r '.AZURE_RESOURCE_GROUP.value // empty')
    if [[ -n "$rg_name" ]]; then
        echo "  Resource Group: $rg_name"
        azd env set AZURE_RESOURCE_GROUP "$rg_name" 2>/dev/null || true
    fi

    # Managed Identity
    local mi_client_id
    mi_client_id=$(echo "$outputs" | jq -r '.AZURE_MANAGED_IDENTITY_CLIENT_ID.value // empty')
    if [[ -n "$mi_client_id" ]]; then
        echo "  Managed Identity Client ID: ${mi_client_id:0:8}..."
        azd env set AZURE_MANAGED_IDENTITY_CLIENT_ID "$mi_client_id" 2>/dev/null || true
    fi
}

# -----------------------------------------------------------------------------
# Verify Provisioned Resources
# -----------------------------------------------------------------------------

verify_resources() {
    log_info "Verifying provisioned resources..."

    local resource_group="${AZURE_RESOURCE_GROUP:-}"
    if [[ -z "$resource_group" ]]; then
        log_warning "AZURE_RESOURCE_GROUP not set. Skipping verification."
        return 0
    fi

    # List resources in the resource group
    local resource_count
    resource_count=$(az resource list --resource-group "$resource_group" --query "length(@)" -o tsv 2>/dev/null || echo "0")

    if [[ "$resource_count" -eq 0 ]]; then
        log_warning "No resources found in resource group: $resource_group"
    else
        log_success "Found $resource_count resources in $resource_group"
    fi
}

# -----------------------------------------------------------------------------
# Configure Container Registry Access
# -----------------------------------------------------------------------------

configure_acr_access() {
    log_info "Configuring Container Registry access..."

    local acr_name="${AZURE_CONTAINER_REGISTRY_NAME:-}"
    if [[ -z "$acr_name" ]]; then
        log_warning "AZURE_CONTAINER_REGISTRY_NAME not set. Skipping ACR configuration."
        return 0
    fi

    # Login to ACR (for local development)
    if az acr login --name "$acr_name" &>/dev/null; then
        log_success "Logged in to Container Registry: $acr_name"
    else
        log_warning "Could not login to ACR. This may be expected in CI/CD."
    fi
}

# -----------------------------------------------------------------------------
# Display Next Steps
# -----------------------------------------------------------------------------

display_next_steps() {
    echo ""
    echo "=============================================="
    echo "  Next Steps"
    echo "=============================================="
    echo ""
    echo "  1. Deploy your application:"
    echo "     azd deploy"
    echo ""
    echo "  2. View your deployed app:"
    echo "     azd show"
    echo ""
    echo "  3. Stream logs:"
    echo "     azd monitor --logs"
    echo ""
    echo "  4. Open Azure Portal:"
    echo "     azd show --output json | jq -r '.services[].endpoints[]'"
    echo ""
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
    echo ""
    echo "=============================================="
    echo "  azd Postprovision Hook"
    echo "=============================================="
    echo ""

    extract_terraform_outputs
    verify_resources
    configure_acr_access
    display_next_steps

    log_success "Postprovision complete!"
    echo ""
}

main "$@"
