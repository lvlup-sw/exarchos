#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Setup Terraform Backend
# Creates Azure Storage Account for Terraform remote state
# -----------------------------------------------------------------------------
#
# This script creates:
# 1. Resource group for Terraform state
# 2. Storage account with secure defaults
# 3. Blob container for state files
#
# Usage:
#   ./setup-backend.sh [environment-name] [location]
#
# Example:
#   ./setup-backend.sh dev eastus2
#
# -----------------------------------------------------------------------------

set -euo pipefail

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

# Default values
DEFAULT_LOCATION="eastus2"
DEFAULT_ENV_NAME="dev"

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

usage() {
    echo "Usage: $0 [environment-name] [location]"
    echo ""
    echo "Arguments:"
    echo "  environment-name    Name of the environment (default: $DEFAULT_ENV_NAME)"
    echo "  location            Azure region (default: $DEFAULT_LOCATION)"
    echo ""
    echo "Environment Variables:"
    echo "  AZURE_ENV_NAME      Override environment name"
    echo "  AZURE_LOCATION      Override location"
    echo ""
    echo "Example:"
    echo "  $0 prod westus2"
    exit 1
}

# -----------------------------------------------------------------------------
# Verify Prerequisites
# -----------------------------------------------------------------------------

# Verifies Azure CLI is installed and authenticated
# Exits with error if prerequisites are not met
verify_prerequisites() {
    log_info "Verifying prerequisites..."

    # Check Azure CLI
    if ! command -v az &>/dev/null; then
        log_error "Azure CLI (az) is not installed. Please install it first."
        exit 1
    fi

    # Check authentication
    if ! az account show &>/dev/null; then
        log_error "Not logged in to Azure CLI. Please run 'az login' first."
        exit 1
    fi

    log_success "Prerequisites verified"
}

# -----------------------------------------------------------------------------
# Create Resource Group
# -----------------------------------------------------------------------------

# Creates an Azure resource group for Terraform state storage
# Arguments:
#   $1 - Resource group name
#   $2 - Azure region location
create_resource_group() {
    local rg_name="$1"
    local location="$2"

    log_info "Creating resource group: $rg_name in $location..."

    if az group show --name "$rg_name" &>/dev/null; then
        log_warning "Resource group '$rg_name' already exists"
        return 0
    fi

    az group create \
        --name "$rg_name" \
        --location "$location" \
        --tags "purpose=terraform-state" "managed-by=setup-backend-script" \
        --output none

    log_success "Resource group created: $rg_name"
}

# -----------------------------------------------------------------------------
# Create Storage Account
# -----------------------------------------------------------------------------

# Creates an Azure Storage Account for Terraform state
# Arguments:
#   $1 - Storage account name (globally unique)
#   $2 - Resource group name
#   $3 - Azure region location
create_storage_account() {
    local sa_name="$1"
    local rg_name="$2"
    local location="$3"

    log_info "Creating storage account: $sa_name..."

    if az storage account show --name "$sa_name" --resource-group "$rg_name" &>/dev/null; then
        log_warning "Storage account '$sa_name' already exists"
        return 0
    fi

    az storage account create \
        --name "$sa_name" \
        --resource-group "$rg_name" \
        --location "$location" \
        --sku Standard_LRS \
        --kind StorageV2 \
        --min-tls-version TLS1_2 \
        --allow-blob-public-access false \
        --https-only true \
        --tags "purpose=terraform-state" "managed-by=setup-backend-script" \
        --output none

    log_success "Storage account created: $sa_name"
}

# -----------------------------------------------------------------------------
# Create Blob Container
# -----------------------------------------------------------------------------

# Creates a blob container for storing Terraform state files
# Arguments:
#   $1 - Storage account name
#   $2 - Resource group name
#   $3 - Container name
create_blob_container() {
    local sa_name="$1"
    local rg_name="$2"
    local container_name="$3"

    log_info "Creating blob container: $container_name..."

    # Enable versioning for state protection
    az storage account blob-service-properties update \
        --account-name "$sa_name" \
        --resource-group "$rg_name" \
        --enable-versioning true \
        --output none 2>/dev/null || true

    # Create container using Azure AD auth
    if az storage container show \
        --name "$container_name" \
        --account-name "$sa_name" \
        --auth-mode login &>/dev/null; then
        log_warning "Container '$container_name' already exists"
        return 0
    fi

    az storage container create \
        --name "$container_name" \
        --account-name "$sa_name" \
        --auth-mode login \
        --output none

    log_success "Blob container created: $container_name"
}

# -----------------------------------------------------------------------------
# Assign RBAC Role
# -----------------------------------------------------------------------------

# Assigns Storage Blob Data Contributor role to current user
# Arguments:
#   $1 - Storage account name
#   $2 - Resource group name
assign_rbac_role() {
    local sa_name="$1"
    local rg_name="$2"

    log_info "Assigning Storage Blob Data Contributor role..."

    # Get current user's object ID
    local user_id=
    user_id=$(az ad signed-in-user show --query "id" -o tsv 2>/dev/null || echo "")

    if [[ -z "$user_id" ]]; then
        log_warning "Could not get current user ID. RBAC assignment skipped."
        return 0
    fi

    # Get storage account resource ID
    local sa_id=
    sa_id=$(az storage account show --name "$sa_name" --resource-group "$rg_name" --query "id" -o tsv)

    # Assign role (ignore if already assigned)
    az role assignment create \
        --role "Storage Blob Data Contributor" \
        --assignee-object-id "$user_id" \
        --assignee-principal-type User \
        --scope "$sa_id" \
        --output none 2>/dev/null || true

    log_success "RBAC role assigned for Azure AD authentication"
}

# -----------------------------------------------------------------------------
# Generate Environment Variables
# -----------------------------------------------------------------------------

# Outputs configuration instructions for using the Terraform backend
# Arguments:
#   $1 - Storage account name
#   $2 - Resource group name
generate_env_vars() {
    local sa_name="$1"
    local rg_name="$2"

    echo ""
    echo "=============================================="
    echo "  Backend Configuration"
    echo "=============================================="
    echo ""
    echo "Add these to your environment or .env file:"
    echo ""
    echo "  export AZURE_TFSTATE_RESOURCE_GROUP=\"$rg_name\""
    echo "  export AZURE_TFSTATE_STORAGE_ACCOUNT=\"$sa_name\""
    echo ""
    echo "For azd, run:"
    echo ""
    echo "  azd env set AZURE_TFSTATE_RESOURCE_GROUP \"$rg_name\""
    echo "  azd env set AZURE_TFSTATE_STORAGE_ACCOUNT \"$sa_name\""
    echo ""
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
    # Parse arguments
    local env_name="${1:-${AZURE_ENV_NAME:-$DEFAULT_ENV_NAME}}"
    local location="${2:-${AZURE_LOCATION:-$DEFAULT_LOCATION}}"

    # Help flag
    if [[ "${1:-}" == "-h" ]] || [[ "${1:-}" == "--help" ]]; then
        usage
    fi

    # Generate resource names
    # Storage account names must be 3-24 chars, lowercase alphanumeric only
    local base_name
    base_name=$(echo "$env_name" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')
    local rg_name="rg-tfstate-${base_name}"
    local sa_name="tfstate${base_name}$(date +%s | tail -c 5)"  # Add unique suffix
    local container_name="tfstate"

    # Ensure storage account name is valid length
    sa_name="${sa_name:0:24}"

    echo ""
    echo "=============================================="
    echo "  Terraform Backend Setup"
    echo "=============================================="
    echo ""
    echo "  Environment: $env_name"
    echo "  Location: $location"
    echo "  Resource Group: $rg_name"
    echo "  Storage Account: $sa_name"
    echo "  Container: $container_name"
    echo ""

    verify_prerequisites
    create_resource_group "$rg_name" "$location"
    create_storage_account "$sa_name" "$rg_name" "$location"
    create_blob_container "$sa_name" "$rg_name" "$container_name"
    assign_rbac_role "$sa_name" "$rg_name"
    generate_env_vars "$sa_name" "$rg_name"

    log_success "Terraform backend setup complete!"
    echo ""
}

main "$@"
