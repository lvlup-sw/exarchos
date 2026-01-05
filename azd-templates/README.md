# Azure Developer CLI (azd) Templates

This template provides a production-ready Azure Container Apps infrastructure using Azure Developer CLI (azd) with Terraform as the infrastructure provider.

## Overview

The template deploys a complete containerized application infrastructure following the Aegis pattern, including:

- **Azure Container Apps Environment** - Serverless container hosting with scale-to-zero
- **Azure Container Registry (ACR)** - Private container image registry
- **Azure Key Vault** - Secure secrets management with RBAC
- **Log Analytics Workspace** - Centralized logging and monitoring
- **User-Assigned Managed Identity** - Secure service-to-service authentication

## Prerequisites

Before using this template, ensure you have the following installed:

| Tool | Version | Installation |
|------|---------|-------------|
| Azure CLI | >= 2.50 | [Install Azure CLI](https://docs.microsoft.com/cli/azure/install-azure-cli) |
| Azure Developer CLI | >= 1.5 | [Install azd](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) |
| Terraform | >= 1.5.0 | [Install Terraform](https://developer.hashicorp.com/terraform/downloads) |

### Azure Requirements

- An active Azure subscription
- Permissions to create resource groups and resources
- Permissions to create service principals (for CI/CD)

Verify your setup:

```bash
# Check Azure CLI
az --version
az login
az account show

# Check azd
azd version
azd auth login

# Check Terraform
terraform version
```

## Quick Start

### 1. Initialize the Environment

```bash
# Navigate to the azd-templates directory
cd azd-templates

# Initialize azd (creates .azure directory and environment)
azd init

# Set environment name (e.g., dev, staging, prod)
azd env new dev
```

### 2. Configure Environment Variables

```bash
# Set the Azure location (optional, defaults to eastus2)
azd env set AZURE_LOCATION eastus2

# For remote state (optional but recommended for teams)
./infra/scripts/setup-backend.sh dev eastus2
```

### 3. Deploy Infrastructure

```bash
# Provision infrastructure and deploy application
azd up

# Or run separately:
azd provision  # Create Azure resources
azd deploy     # Deploy application code
```

### 4. View Deployment

```bash
# Show deployment information
azd show

# Monitor application logs
azd monitor --logs
```

## Environment Configuration

### Directory Structure

```
azd-templates/
├── azure.yaml              # azd configuration (services, hooks)
├── .azure/
│   └── config.json         # Default environment settings
├── infra/
│   ├── main.tf            # Root Terraform configuration
│   ├── backend.tf         # Remote state backend config
│   ├── variables.tf       # Input variables
│   ├── outputs.tf         # Output values for azd
│   ├── provider.conf.json # Backend configuration template
│   ├── modules/
│   │   └── container-apps/  # Container Apps module
│   └── scripts/
│       ├── preprovision.sh   # Pre-deployment hook
│       ├── postprovision.sh  # Post-deployment hook
│       └── setup-backend.sh  # Backend storage setup
└── src/                    # Application source (add your services here)
```

### Environment File (.azure/config.json)

The default environment configuration:

```json
{
  "version": 1,
  "defaultEnvironment": "dev"
}
```

### azd Environment Variables

azd automatically sets these variables, which are passed to Terraform:

| Variable | Description | Default |
|----------|-------------|---------|
| `AZURE_ENV_NAME` | Environment name (dev, staging, prod) | From `azd env` |
| `AZURE_LOCATION` | Azure region for deployment | eastus2 |
| `AZURE_RESOURCE_GROUP` | Resource group name | rg-{env_name} |
| `AZURE_SUBSCRIPTION_ID` | Target subscription | From `az account` |

### Terraform Variables (TF_VAR_*)

The preprovision hook sets these from azd environment:

| Variable | Description | Default |
|----------|-------------|---------|
| `TF_VAR_environment_name` | Environment identifier | From AZURE_ENV_NAME |
| `TF_VAR_location` | Azure region | eastus2 |
| `TF_VAR_resource_group_name` | Resource group | From AZURE_RESOURCE_GROUP |
| `TF_VAR_principal_id` | Deployer's principal ID | Auto-detected |
| `TF_VAR_cost_center` | Cost allocation tag | engineering |
| `TF_VAR_log_retention_days` | Log retention period | 30 |
| `TF_VAR_sku_name` | Container Apps SKU | Consumption |

## Infrastructure Overview

### Provisioned Resources

The template creates the following resources:

```
Resource Group (rg-{environment})
├── Log Analytics Workspace (log-{environment})
├── Container Registry (acr{environment}{suffix})
├── Key Vault (kv-{environment}-{suffix})
├── User-Assigned Managed Identity (id-{environment})
└── Container Apps Environment (cae-{environment})
    └── Your Container Apps (deployed via azd deploy)
```

### Resource Naming Convention

Resources follow the pattern: `{type}-{environment}-{suffix}`

- Prefix indicates resource type (log, acr, kv, id, cae)
- Environment name from azd
- Random suffix ensures global uniqueness (ACR, Key Vault)

### Terraform State Management

By default, Terraform uses local state. For team collaboration, configure remote state:

```bash
# Create storage account for state
./infra/scripts/setup-backend.sh dev eastus2

# Set environment variables
azd env set AZURE_TFSTATE_RESOURCE_GROUP "rg-tfstate-dev"
azd env set AZURE_TFSTATE_STORAGE_ACCOUNT "tfstatedev12345"

# Re-initialize with remote backend
azd provision
```

Remote state configuration (`provider.conf.json`):

```json
{
  "resource_group_name": "${AZURE_TFSTATE_RESOURCE_GROUP}",
  "storage_account_name": "${AZURE_TFSTATE_STORAGE_ACCOUNT}",
  "container_name": "tfstate",
  "key": "${AZURE_ENV_NAME}.terraform.tfstate",
  "use_azuread_auth": true
}
```

### Managed Identity Setup

The template creates a user-assigned managed identity with:

- **AcrPull** on Container Registry - Pull container images
- **Key Vault Secrets User** on Key Vault - Read secrets

The deploying user/service principal receives:

- **AcrPush** on Container Registry - Push container images
- **Key Vault Administrator** on Key Vault - Manage secrets

## Customization Guide

### Adding Services to azure.yaml

Edit `azure.yaml` to add new services:

```yaml
services:
  api:
    project: ./src/Api
    host: containerapp
    language: dotnet

  web:
    project: ./src/Web
    host: containerapp
    language: typescript

  worker:
    project: ./src/Worker
    host: containerapp
    language: python
```

### Extending Terraform Modules

To add new resources, modify `infra/modules/container-apps/main.tf`:

```hcl
# Example: Add a storage account
resource "azurerm_storage_account" "data" {
  name                     = "st${local.clean_prefix}${random_string.suffix.result}"
  resource_group_name      = data.azurerm_resource_group.main.name
  location                 = data.azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  tags                     = var.tags
}
```

Add corresponding output in `outputs.tf`:

```hcl
output "storage_account_name" {
  description = "The name of the storage account"
  value       = azurerm_storage_account.data.name
}
```

### Custom Lifecycle Hooks

Hooks are defined in `azure.yaml`:

```yaml
hooks:
  preprovision:
    shell: bash
    run: ./infra/scripts/preprovision.sh
    interactive: true
    continueOnError: false

  postprovision:
    shell: bash
    run: ./infra/scripts/postprovision.sh
    continueOnError: false

  # Add custom hooks
  predeploy:
    shell: bash
    run: ./scripts/predeploy.sh
```

### Environment-Specific Configuration

Development environments automatically receive cost-optimized settings:

- Basic SKU for Container Registry (vs Standard in prod)
- Purge protection disabled on Key Vault
- Scale-to-zero enabled

Controlled by `is_dev_environment` in `main.tf`:

```hcl
locals {
  is_dev_environment = contains(["dev", "development", "sandbox"], lower(var.environment_name))
}
```

## Troubleshooting

### Common Issues

#### Authentication Errors

```bash
# Re-authenticate to Azure
az login
azd auth login

# Verify subscription
az account show
az account set --subscription "<subscription-id>"
```

#### Terraform State Lock

```bash
# Force unlock (use with caution)
cd infra
terraform force-unlock <lock-id>
```

#### Resource Group Already Exists

```bash
# Check existing resources
az group show --name rg-dev

# Delete and recreate (caution: destroys all resources)
azd down --force --purge
azd up
```

#### Container Registry Access Denied

```bash
# Verify ACR permissions
az acr show --name <acr-name> --query "id" -o tsv
az role assignment list --scope <acr-id> --output table

# Re-login to ACR
az acr login --name <acr-name>
```

### Checking Deployment Logs

```bash
# View azd logs
azd show --output json

# View Container Apps logs
az containerapp logs show \
  --name <app-name> \
  --resource-group rg-dev \
  --follow

# Query Log Analytics
az monitor log-analytics query \
  --workspace <workspace-id> \
  --analytics-query "ContainerAppConsoleLogs | take 100"
```

### State Recovery

If Terraform state becomes corrupted:

```bash
# List current state
cd infra
terraform state list

# Import existing resources
terraform import module.container_apps.azurerm_container_registry.main /subscriptions/.../Microsoft.ContainerRegistry/registries/<name>

# Refresh state from Azure
terraform refresh
```

### Destroying Resources

```bash
# Remove all deployed resources
azd down

# Force delete without confirmation
azd down --force

# Purge soft-deleted Key Vault
azd down --force --purge
```

## Related Documentation

- [Azure Developer CLI Documentation](https://learn.microsoft.com/azure/developer/azure-developer-cli/)
- [Azure Container Apps Documentation](https://learn.microsoft.com/azure/container-apps/)
- [Terraform AzureRM Provider](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs)
