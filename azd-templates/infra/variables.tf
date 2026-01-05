# -----------------------------------------------------------------------------
# Input Variables
# These variables are populated by Azure Developer CLI (azd)
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Required Variables (from azd)
# -----------------------------------------------------------------------------

variable "environment_name" {
  description = "The name of the azd environment (e.g., dev, staging, prod)"
  type        = string

  validation {
    condition     = length(var.environment_name) >= 2 && length(var.environment_name) <= 32
    error_message = "Environment name must be between 2 and 32 characters."
  }
}

variable "location" {
  description = "The Azure region for resource deployment"
  type        = string
  default     = "eastus2"

  validation {
    condition     = can(regex("^[a-z0-9]+$", var.location))
    error_message = "Location must be a valid Azure region name (lowercase, no spaces)."
  }
}

variable "resource_group_name" {
  description = "The name of the resource group to deploy resources into"
  type        = string

  validation {
    condition     = length(var.resource_group_name) >= 1 && length(var.resource_group_name) <= 90
    error_message = "Resource group name must be between 1 and 90 characters."
  }
}

variable "principal_id" {
  description = "The principal ID for RBAC assignments (typically the deploying user or service principal)"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Optional Variables
# -----------------------------------------------------------------------------

variable "cost_center" {
  description = "Cost center tag for resource billing allocation"
  type        = string
  default     = "engineering"
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
  description = "SKU name for Container Apps Environment (Consumption or Premium)"
  type        = string
  default     = "Consumption"

  validation {
    condition     = contains(["Consumption", "Premium"], var.sku_name)
    error_message = "SKU name must be 'Consumption' or 'Premium'."
  }
}

# -----------------------------------------------------------------------------
# Feature Flags
# -----------------------------------------------------------------------------

variable "enable_zone_redundancy" {
  description = "Enable zone redundancy for Container Apps Environment (requires Premium SKU)"
  type        = bool
  default     = false
}

variable "enable_internal_only" {
  description = "Restrict Container Apps Environment to internal traffic only"
  type        = bool
  default     = false
}
