# -----------------------------------------------------------------------------
# Main Terraform Configuration
# Aegis Pattern - Azure Container Apps Infrastructure
# -----------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.80"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "~> 1.10"
    }
  }
}

# -----------------------------------------------------------------------------
# Provider Configuration
# -----------------------------------------------------------------------------

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
  }
}

provider "azapi" {}

# -----------------------------------------------------------------------------
# Local Values
# Common tags and naming conventions following Aegis pattern
# -----------------------------------------------------------------------------

locals {
  # Resource naming convention: {project}-{environment}-{resource}
  resource_prefix = "aegis-${var.environment_name}"

  # Common tags applied to all resources
  common_tags = {
    environment      = var.environment_name
    managed_by       = "terraform"
    azd_env_name     = var.environment_name
    project          = "aegis"
    cost_center      = var.cost_center
    created_by       = "azd"
  }

  # Determine if this is a development environment (for scale-to-zero config)
  is_dev_environment = contains(["dev", "development", "sandbox"], lower(var.environment_name))
}

# -----------------------------------------------------------------------------
# Container Apps Module
# Deploys the complete container apps infrastructure
# -----------------------------------------------------------------------------

module "container_apps" {
  source = "./modules/container-apps"

  environment_name    = var.environment_name
  location            = var.location
  resource_group_name = var.resource_group_name
  principal_id        = var.principal_id
  tags                = local.common_tags
  is_dev_environment  = local.is_dev_environment

  # Optional configuration
  log_retention_days = var.log_retention_days
  sku_name           = var.sku_name
}
