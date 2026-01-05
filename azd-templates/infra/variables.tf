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
  description = <<-EOT
    Workload profile type for Container Apps Environment.
    Valid values:
    - Consumption: Serverless, scale-to-zero (default)
    - D4, D8, D16, D32: General purpose dedicated compute
    - E4, E8, E16, E32: Memory optimized dedicated compute
    See: https://learn.microsoft.com/en-us/azure/container-apps/workload-profiles-overview
  EOT
  type        = string
  default     = "Consumption"

  validation {
    condition = contains([
      "Consumption",
      # General purpose (D-series)
      "D4", "D8", "D16", "D32",
      # Memory optimized (E-series)
      "E4", "E8", "E16", "E32",
    ], var.sku_name)
    error_message = "Invalid sku_name. Valid values: Consumption, D4, D8, D16, D32, E4, E8, E16, E32. See https://learn.microsoft.com/en-us/azure/container-apps/workload-profiles-overview"
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
