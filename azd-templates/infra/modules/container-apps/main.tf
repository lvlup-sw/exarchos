# -----------------------------------------------------------------------------
# Container Apps Module
# Deploys Azure Container Apps Environment with supporting infrastructure
# -----------------------------------------------------------------------------
#
# This module creates:
#   - Resource Group (or uses existing)
#   - Log Analytics Workspace (for monitoring)
#   - Azure Container Registry (for container images)
#   - Key Vault (for secrets management)
#   - User-Assigned Managed Identity (for secure access)
#   - Container Apps Environment (for running containers)
#
# Following Aegis pattern for Azure infrastructure
# -----------------------------------------------------------------------------

terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

# -----------------------------------------------------------------------------
# Local Values
# -----------------------------------------------------------------------------

locals {
  # Clean resource prefix (remove special characters, limit length)
  clean_prefix = substr(replace(lower(var.environment_name), "/[^a-z0-9]/", ""), 0, 16)

  # Resource names following Azure naming conventions
  resource_names = {
    log_analytics = "log-${local.clean_prefix}"
    acr           = "acr${local.clean_prefix}${random_string.suffix.result}"
    key_vault     = "kv-${local.clean_prefix}-${random_string.suffix.result}"
    identity      = "id-${local.clean_prefix}"
    container_env = "cae-${local.clean_prefix}"
  }
}

# -----------------------------------------------------------------------------
# Random Suffix for Globally Unique Names
# -----------------------------------------------------------------------------

resource "random_string" "suffix" {
  length  = 6
  lower   = true
  upper   = false
  numeric = true
  special = false
}

# -----------------------------------------------------------------------------
# Resource Group
# Uses existing resource group passed from azd
# -----------------------------------------------------------------------------

data "azurerm_resource_group" "main" {
  name = var.resource_group_name
}

# -----------------------------------------------------------------------------
# Log Analytics Workspace
# Central logging for Container Apps and other resources
# -----------------------------------------------------------------------------

resource "azurerm_log_analytics_workspace" "main" {
  name                = local.resource_names.log_analytics
  location            = data.azurerm_resource_group.main.location
  resource_group_name = data.azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Azure Container Registry
# Private registry for container images
# -----------------------------------------------------------------------------

resource "azurerm_container_registry" "main" {
  name                = local.resource_names.acr
  resource_group_name = data.azurerm_resource_group.main.name
  location            = data.azurerm_resource_group.main.location
  sku                 = var.is_dev_environment ? "Basic" : "Standard"
  admin_enabled       = false

  tags = var.tags
}

# -----------------------------------------------------------------------------
# User-Assigned Managed Identity
# Used by Container Apps to access ACR, Key Vault, and other Azure services
# -----------------------------------------------------------------------------

resource "azurerm_user_assigned_identity" "main" {
  name                = local.resource_names.identity
  resource_group_name = data.azurerm_resource_group.main.name
  location            = data.azurerm_resource_group.main.location

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Key Vault
# Secure storage for application secrets
# -----------------------------------------------------------------------------

data "azurerm_client_config" "current" {}

resource "azurerm_key_vault" "main" {
  name                        = local.resource_names.key_vault
  location                    = data.azurerm_resource_group.main.location
  resource_group_name         = data.azurerm_resource_group.main.name
  tenant_id                   = data.azurerm_client_config.current.tenant_id
  sku_name                    = "standard"
  soft_delete_retention_days  = 7
  purge_protection_enabled    = var.is_dev_environment ? false : true

  # Enable Azure RBAC for access control (recommended over access policies)
  rbac_authorization_enabled = true

  # Network rules - allow Azure services
  network_acls {
    default_action = "Allow"
    bypass         = "AzureServices"
  }

  tags = var.tags
}

# -----------------------------------------------------------------------------
# RBAC Role Assignments
# Grant managed identity access to ACR and Key Vault
# -----------------------------------------------------------------------------

# Grant managed identity AcrPull role on Container Registry
resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.main.principal_id
}

# Grant managed identity Key Vault Secrets User role
resource "azurerm_role_assignment" "key_vault_secrets" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.main.principal_id
}

# Grant deploying principal Key Vault Administrator role (if principal_id provided)
resource "azurerm_role_assignment" "key_vault_admin" {
  count                = var.principal_id != "" ? 1 : 0
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Administrator"
  principal_id         = var.principal_id
}

# Grant deploying principal AcrPush role (if principal_id provided)
resource "azurerm_role_assignment" "acr_push" {
  count                = var.principal_id != "" ? 1 : 0
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPush"
  principal_id         = var.principal_id
}

# -----------------------------------------------------------------------------
# Container Apps Environment
# Serverless environment for running container applications
# -----------------------------------------------------------------------------

resource "azurerm_container_app_environment" "main" {
  name                       = local.resource_names.container_env
  location                   = data.azurerm_resource_group.main.location
  resource_group_name        = data.azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  # Infrastructure subnet (optional - for VNet integration)
  # infrastructure_subnet_id = var.infrastructure_subnet_id

  # Consumption workload profile (serverless, scale-to-zero)
  # Note: Consumption profiles do not use minimum_count/maximum_count
  dynamic "workload_profile" {
    for_each = var.sku_name == "Consumption" ? [1] : []
    content {
      name                  = "Consumption"
      workload_profile_type = "Consumption"
    }
  }

  # Dedicated workload profile (for non-Consumption SKUs like D4, D8, E4, E8, etc.)
  dynamic "workload_profile" {
    for_each = var.sku_name != "Consumption" ? [1] : []
    content {
      name                  = var.sku_name
      workload_profile_type = var.sku_name
      minimum_count         = 1
      maximum_count         = 3
    }
  }

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Diagnostic Settings
# Send platform logs to Log Analytics
# -----------------------------------------------------------------------------

resource "azurerm_monitor_diagnostic_setting" "container_env" {
  name                       = "diag-${local.resource_names.container_env}"
  target_resource_id         = azurerm_container_app_environment.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "ContainerAppConsoleLogs"
  }

  enabled_log {
    category = "ContainerAppSystemLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "key_vault" {
  name                       = "diag-${local.resource_names.key_vault}"
  target_resource_id         = azurerm_key_vault.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "AuditEvent"
  }

  enabled_log {
    category = "AzurePolicyEvaluationDetails"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}
