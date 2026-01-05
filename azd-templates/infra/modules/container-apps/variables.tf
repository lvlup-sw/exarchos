# -----------------------------------------------------------------------------
# Container Apps Module Variables
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Required Variables
# -----------------------------------------------------------------------------

variable "environment_name" {
  description = "The name of the environment (e.g., dev, staging, prod)"
  type        = string

  validation {
    condition     = length(var.environment_name) >= 2 && length(var.environment_name) <= 32
    error_message = "Environment name must be between 2 and 32 characters."
  }
}

variable "location" {
  description = "The Azure region for resource deployment"
  type        = string
}

variable "resource_group_name" {
  description = "The name of the resource group to deploy resources into"
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Optional Variables
# -----------------------------------------------------------------------------

variable "principal_id" {
  description = "The principal ID for RBAC assignments (deploying user or service principal)"
  type        = string
  default     = ""
}

variable "is_dev_environment" {
  description = "Whether this is a development environment (enables cost-saving configurations)"
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "Number of days to retain logs in Log Analytics workspace"
  type        = number
  default     = 30

  validation {
    condition     = var.log_retention_days >= 7 && var.log_retention_days <= 730
    error_message = "Log retention must be between 7 and 730 days."
  }
}

variable "sku_name" {
  description = "SKU name for Container Apps Environment workload profile"
  type        = string
  default     = "Consumption"

  validation {
    condition     = contains(["Consumption", "Premium"], var.sku_name)
    error_message = "SKU name must be 'Consumption' or 'Premium'."
  }
}

# -----------------------------------------------------------------------------
# Network Variables (for future VNet integration)
# -----------------------------------------------------------------------------

variable "infrastructure_subnet_id" {
  description = "The ID of the subnet for Container Apps Environment (for VNet integration)"
  type        = string
  default     = null
}

variable "internal_only" {
  description = "Restrict Container Apps Environment to internal traffic only"
  type        = bool
  default     = false
}
