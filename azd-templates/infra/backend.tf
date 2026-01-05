# -----------------------------------------------------------------------------
# Terraform Backend Configuration
# Azure Storage Backend for Remote State
# -----------------------------------------------------------------------------
#
# Backend configuration is loaded from provider.conf.json or environment variables.
# This enables different storage accounts per environment.
#
# Required environment variables (if not using provider.conf.json):
#   - ARM_ACCESS_KEY or ARM_SAS_TOKEN (for authentication)
#
# Or configure Azure AD authentication:
#   - ARM_USE_AZUREAD=true
#   - ARM_TENANT_ID
#   - ARM_CLIENT_ID
#   - ARM_CLIENT_SECRET (or use managed identity)
#
# Usage:
#   terraform init -backend-config="provider.conf.json"
#
# -----------------------------------------------------------------------------

terraform {
  backend "azurerm" {
    # These values are provided via -backend-config or provider.conf.json
    # resource_group_name  = "tfstate-rg"
    # storage_account_name = "tfstateaccount"
    # container_name       = "tfstate"
    # key                  = "terraform.tfstate"

    # Recommended: Use Azure AD authentication instead of access keys
    # use_azuread_auth = true
  }
}
