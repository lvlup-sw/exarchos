# -----------------------------------------------------------------------------
# Outputs
# azd-compatible outputs for integration with Azure Developer CLI
# -----------------------------------------------------------------------------
#
# These outputs follow the azd naming convention (AZURE_*) to enable
# seamless integration with azd deploy and other azd commands.
#
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Container Registry Outputs
# -----------------------------------------------------------------------------

output "AZURE_CONTAINER_REGISTRY_ENDPOINT" {
  description = "The login server URL for Azure Container Registry"
  value       = module.container_apps.container_registry_login_server
}

output "AZURE_CONTAINER_REGISTRY_NAME" {
  description = "The name of the Azure Container Registry"
  value       = module.container_apps.container_registry_name
}

# -----------------------------------------------------------------------------
# Container Apps Environment Outputs
# -----------------------------------------------------------------------------

output "AZURE_CONTAINER_APPS_ENVIRONMENT_NAME" {
  description = "The name of the Container Apps Environment"
  value       = module.container_apps.container_apps_environment_name
}

output "AZURE_CONTAINER_APPS_ENVIRONMENT_ID" {
  description = "The resource ID of the Container Apps Environment"
  value       = module.container_apps.container_apps_environment_id
}

output "AZURE_CONTAINER_APPS_ENVIRONMENT_DEFAULT_DOMAIN" {
  description = "The default domain of the Container Apps Environment"
  value       = module.container_apps.container_apps_environment_default_domain
}

# -----------------------------------------------------------------------------
# Resource Group Outputs
# -----------------------------------------------------------------------------

output "AZURE_RESOURCE_GROUP" {
  description = "The name of the resource group containing all resources"
  value       = module.container_apps.resource_group_name
}

output "AZURE_LOCATION" {
  description = "The Azure region where resources are deployed"
  value       = module.container_apps.location
}

# -----------------------------------------------------------------------------
# Key Vault Outputs
# -----------------------------------------------------------------------------

output "AZURE_KEY_VAULT_NAME" {
  description = "The name of the Key Vault for secrets management"
  value       = module.container_apps.key_vault_name
}

output "AZURE_KEY_VAULT_ENDPOINT" {
  description = "The URI of the Key Vault"
  value       = module.container_apps.key_vault_uri
}

# -----------------------------------------------------------------------------
# Log Analytics Outputs
# -----------------------------------------------------------------------------

output "AZURE_LOG_ANALYTICS_WORKSPACE_NAME" {
  description = "The name of the Log Analytics workspace"
  value       = module.container_apps.log_analytics_workspace_name
}

output "AZURE_LOG_ANALYTICS_WORKSPACE_ID" {
  description = "The resource ID of the Log Analytics workspace"
  value       = module.container_apps.log_analytics_workspace_id
}

# -----------------------------------------------------------------------------
# Managed Identity Outputs
# -----------------------------------------------------------------------------

output "AZURE_MANAGED_IDENTITY_CLIENT_ID" {
  description = "The client ID of the user-assigned managed identity"
  value       = module.container_apps.managed_identity_client_id
}

output "AZURE_MANAGED_IDENTITY_PRINCIPAL_ID" {
  description = "The principal ID of the user-assigned managed identity"
  value       = module.container_apps.managed_identity_principal_id
}
