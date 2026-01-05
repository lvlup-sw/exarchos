# Azure OIDC Setup for GitHub Actions

This guide covers setting up OpenID Connect (OIDC) authentication between GitHub Actions and Azure, enabling secure, passwordless authentication without storing long-lived credentials.

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Service Principal Creation](#2-service-principal-creation)
3. [Federated Credential Setup](#3-federated-credential-setup)
4. [Role Assignment](#4-role-assignment)
5. [GitHub Repository Configuration](#5-github-repository-configuration)
6. [GitHub Actions Workflow Usage](#6-github-actions-workflow-usage)
7. [Verification Commands](#7-verification-commands)
8. [Troubleshooting](#8-troubleshooting)
9. [Additional Resources](#9-additional-resources)

---

## 1. Prerequisites

Before starting, ensure you have the following:

- **Azure subscription** - An active Azure subscription with sufficient permissions
- **Azure CLI** - Version 2.30.0 or later installed and configured
  ```bash
  az --version
  az login
  ```
- **GitHub repository** - A repository with GitHub Actions enabled
- **Admin access** - Owner or admin permissions on both:
  - Azure subscription (or at minimum, Application Administrator role in Azure AD)
  - GitHub repository (to configure secrets)

### Verify Azure CLI Login

```bash
# Verify you're logged in to the correct subscription
az account show --query "{Name:name, SubscriptionId:id, TenantId:tenantId}" -o table
```

---

## 2. Service Principal Creation

Create an Azure AD application and service principal that GitHub Actions will use for authentication.

### Step 2.1: Create Azure AD Application

```bash
# Create the Azure AD application
az ad app create --display-name "github-actions-oidc"
```

Save the output - you'll need the `appId` (also called Application ID or Client ID).

### Step 2.2: Create Service Principal

```bash
# Create service principal for the application
# Replace <app-id> with the appId from the previous command
az ad sp create --id <app-id>
```

### Step 2.3: Retrieve Required IDs

```bash
# Get the Application (Client) ID
az ad app list --display-name "github-actions-oidc" --query "[0].appId" -o tsv

# Get the Application Object ID (needed for federated credentials)
az ad app list --display-name "github-actions-oidc" --query "[0].id" -o tsv

# Get the Tenant ID
az account show --query "tenantId" -o tsv

# Get the Subscription ID
az account show --query "id" -o tsv
```

**Important:** Note the difference between:
- **Application (Client) ID** (`appId`) - Used for authentication
- **Application Object ID** (`id`) - Used for configuring federated credentials

---

## 3. Federated Credential Setup

Federated credentials establish trust between GitHub Actions and your Azure AD application without requiring secrets.

### Step 3.1: Create Federated Credential for Main Branch

This allows workflows running on the `main` branch to authenticate:

```bash
# Replace <app-object-id> with the Application Object ID
# Replace OWNER/REPO with your GitHub repository (e.g., myorg/myrepo)
az ad app federated-credential create \
  --id <app-object-id> \
  --parameters '{
    "name": "github-main",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:OWNER/REPO:ref:refs/heads/main",
    "description": "GitHub Actions - main branch",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

### Step 3.2: Create Federated Credential for Pull Requests

This allows workflows triggered by pull requests to authenticate:

```bash
az ad app federated-credential create \
  --id <app-object-id> \
  --parameters '{
    "name": "github-pr",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:OWNER/REPO:pull_request",
    "description": "GitHub Actions - pull requests",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

### Step 3.3: Additional Federated Credentials (Optional)

For other branches or environments:

```bash
# For a specific environment (e.g., production)
az ad app federated-credential create \
  --id <app-object-id> \
  --parameters '{
    "name": "github-env-production",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:OWNER/REPO:environment:production",
    "description": "GitHub Actions - production environment",
    "audiences": ["api://AzureADTokenExchange"]
  }'

# For release tags
az ad app federated-credential create \
  --id <app-object-id> \
  --parameters '{
    "name": "github-tags",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:OWNER/REPO:ref:refs/tags/*",
    "description": "GitHub Actions - release tags",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

### Verify Federated Credentials

```bash
# List all federated credentials for the application
az ad app federated-credential list --id <app-object-id> -o table
```

---

## 4. Role Assignment

Assign appropriate Azure RBAC roles to the service principal.

### Step 4.1: Assign Contributor Role (Subscription Level)

```bash
# Assign Contributor role to the entire subscription
# Replace <app-id> with the Application (Client) ID
# Replace <subscription-id> with your Azure subscription ID
az role assignment create \
  --assignee <app-id> \
  --role "Contributor" \
  --scope /subscriptions/<subscription-id>
```

### Step 4.2: Assign Role to Specific Resource Group (Recommended)

For better security, scope permissions to specific resource groups:

```bash
# Assign Contributor role to a specific resource group
az role assignment create \
  --assignee <app-id> \
  --role "Contributor" \
  --scope /subscriptions/<subscription-id>/resourceGroups/<resource-group-name>
```

### Step 4.3: Custom Role Assignment

For least-privilege access, assign only the roles needed:

```bash
# Example: Assign multiple specific roles
az role assignment create \
  --assignee <app-id> \
  --role "AcrPush" \
  --scope /subscriptions/<subscription-id>/resourceGroups/<rg>/providers/Microsoft.ContainerRegistry/registries/<acr-name>

az role assignment create \
  --assignee <app-id> \
  --role "Azure Kubernetes Service Cluster User Role" \
  --scope /subscriptions/<subscription-id>/resourceGroups/<rg>/providers/Microsoft.ContainerService/managedClusters/<aks-name>
```

### Verify Role Assignments

```bash
# List all role assignments for the service principal
az role assignment list --assignee <app-id> -o table
```

---

## 5. GitHub Repository Configuration

Configure your GitHub repository with the required secrets.

### Required Secrets

Add these secrets to your GitHub repository:

| Secret Name | Value | Description |
|-------------|-------|-------------|
| `AZURE_CLIENT_ID` | Application (Client) ID | The `appId` from step 2 |
| `AZURE_TENANT_ID` | Directory (Tenant) ID | Your Azure AD tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Subscription ID | Your Azure subscription ID |

### Adding Secrets via GitHub UI

1. Navigate to your repository on GitHub
2. Go to **Settings** > **Secrets and variables** > **Actions**
3. Click **New repository secret**
4. Add each secret:

<!-- Screenshot: GitHub repository settings - Secrets page -->
```
[Screenshot placeholder: Repository Settings > Secrets > Actions]
```

5. Enter the secret name and value
6. Click **Add secret**

<!-- Screenshot: Adding a new secret -->
```
[Screenshot placeholder: New secret dialog with AZURE_CLIENT_ID]
```

### Adding Secrets via GitHub CLI

```bash
# Using GitHub CLI (gh)
gh secret set AZURE_CLIENT_ID --body "<your-client-id>"
gh secret set AZURE_TENANT_ID --body "<your-tenant-id>"
gh secret set AZURE_SUBSCRIPTION_ID --body "<your-subscription-id>"
```

### Using GitHub Environments (Optional)

For environment-specific deployments:

1. Go to **Settings** > **Environments**
2. Create environments (e.g., `production`, `staging`)
3. Add environment-specific secrets
4. Configure protection rules (required reviewers, wait timer)

---

## 6. GitHub Actions Workflow Usage

### Basic OIDC Login

```yaml
name: Azure OIDC Example

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  id-token: write   # Required for OIDC token request
  contents: read    # Required for actions/checkout

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Azure Login (OIDC)
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - name: Run Azure CLI commands
        run: |
          az account show
          az group list -o table
```

### With Environment Protection

```yaml
name: Production Deploy

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production  # Requires environment-specific federated credential

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Azure Login
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - name: Deploy to Azure
        run: |
          # Your deployment commands here
          az webapp deploy --name myapp --resource-group myrg
```

### Multi-Environment Workflow

```yaml
name: Multi-Environment Deploy

on:
  push:
    branches: [main, develop]

permissions:
  id-token: write
  contents: read

jobs:
  deploy-staging:
    if: github.ref == 'refs/heads/develop'
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      - run: echo "Deploying to staging..."

  deploy-production:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      - run: echo "Deploying to production..."
```

### Using with Azure Container Registry

```yaml
- name: Azure Login
  uses: azure/login@v2
  with:
    client-id: ${{ secrets.AZURE_CLIENT_ID }}
    tenant-id: ${{ secrets.AZURE_TENANT_ID }}
    subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

- name: Login to ACR
  run: az acr login --name myregistry

- name: Build and Push
  run: |
    docker build -t myregistry.azurecr.io/myapp:${{ github.sha }} .
    docker push myregistry.azurecr.io/myapp:${{ github.sha }}
```

---

## 7. Verification Commands

### Verify Azure Login from GitHub Actions

Add this step to your workflow for debugging:

```yaml
- name: Verify Azure Connection
  run: |
    echo "=== Account Info ==="
    az account show -o table

    echo "=== Subscription Access ==="
    az account list -o table

    echo "=== Resource Groups ==="
    az group list -o table

    echo "=== Current Identity ==="
    az ad signed-in-user show 2>/dev/null || echo "Service Principal login"
```

### Local Testing with Federated Token

While you cannot fully test OIDC locally (tokens are only issued in GitHub Actions), you can verify your setup:

```bash
# Verify the application exists
az ad app show --id <app-id> --query "{Name:displayName, AppId:appId}" -o table

# Verify federated credentials are configured
az ad app federated-credential list --id <app-object-id> -o table

# Verify role assignments
az role assignment list --assignee <app-id> --query "[].{Role:roleDefinitionName, Scope:scope}" -o table

# Test service principal login (with client secret - for local testing only)
# Note: This uses a secret, not OIDC, but verifies the SP is configured correctly
az login --service-principal \
  --username <app-id> \
  --tenant <tenant-id> \
  --password <client-secret>
```

### Verify Permissions

```bash
# After login, verify you have expected permissions
az account show
az group list -o table

# Test specific resource access
az webapp list -o table
az acr list -o table
```

---

## 8. Troubleshooting

### Error: AADSTS70021 - No matching federated identity record found

**Cause:** The subject claim in the GitHub Actions token doesn't match any federated credential.

**Solutions:**

1. **Verify the subject format** - Check the workflow trigger and branch:
   ```bash
   # For main branch pushes
   subject: "repo:OWNER/REPO:ref:refs/heads/main"

   # For pull requests
   subject: "repo:OWNER/REPO:pull_request"

   # For environments
   subject: "repo:OWNER/REPO:environment:production"
   ```

2. **Check repository name** - Ensure exact match including case:
   ```bash
   az ad app federated-credential list --id <app-object-id> --query "[].subject"
   ```

3. **Debug the token subject** - Add this step to see the actual subject:
   ```yaml
   - name: Debug OIDC Token
     run: |
       echo "Repository: ${{ github.repository }}"
       echo "Ref: ${{ github.ref }}"
       echo "Event: ${{ github.event_name }}"
   ```

### Error: AADSTS700024 - Client assertion is not within its valid time range

**Cause:** Token timing issue, usually due to clock skew or expired token.

**Solutions:**

1. **Retry the workflow** - Transient timing issues often resolve on retry
2. **Check for workflow delays** - Long-running steps before login can cause token expiration
3. **Move login step earlier** - Place Azure login immediately after checkout

### Error: Authorization_RequestDenied

**Cause:** Service principal lacks required permissions.

**Solutions:**

1. **Verify role assignments:**
   ```bash
   az role assignment list --assignee <app-id> -o table
   ```

2. **Check scope** - Ensure the role is assigned at the correct scope level

3. **Wait for propagation** - New role assignments can take up to 5 minutes to propagate

### Error: AADSTS7000215 - Invalid client secret

**Cause:** Using secret-based authentication instead of OIDC.

**Solutions:**

1. **Remove client secret** from workflow - OIDC doesn't use secrets
2. **Ensure correct action version** - Use `azure/login@v2` or later
3. **Verify workflow syntax:**
   ```yaml
   # Correct (OIDC)
   with:
     client-id: ${{ secrets.AZURE_CLIENT_ID }}
     tenant-id: ${{ secrets.AZURE_TENANT_ID }}
     subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

   # Incorrect (secret-based)
   with:
     creds: ${{ secrets.AZURE_CREDENTIALS }}
   ```

### Error: id-token permission not set

**Cause:** Workflow doesn't have permission to request OIDC tokens.

**Solution:** Add permissions block:
```yaml
permissions:
  id-token: write
  contents: read
```

### Workflow Succeeds but Azure Commands Fail

**Cause:** Login succeeded but lacking resource permissions.

**Solutions:**

1. **Check subscription context:**
   ```yaml
   - run: az account show
   ```

2. **Verify resource group access:**
   ```yaml
   - run: az group show --name <resource-group>
   ```

3. **Check specific resource permissions** - Some resources require additional roles

### Debug Mode

Enable detailed logging in your workflow:

```yaml
env:
  ACTIONS_STEP_DEBUG: true

steps:
  - name: Azure Login
    uses: azure/login@v2
    with:
      client-id: ${{ secrets.AZURE_CLIENT_ID }}
      tenant-id: ${{ secrets.AZURE_TENANT_ID }}
      subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      enable-AzPSSession: false
```

---

## 9. Additional Resources

### Official Documentation

- [Azure OIDC with GitHub Actions](https://docs.microsoft.com/en-us/azure/developer/github/connect-from-azure) - Microsoft's official guide
- [GitHub OIDC Documentation](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect) - GitHub's security documentation
- [azure/login Action](https://github.com/Azure/login) - GitHub Action repository and documentation
- [Azure CLI Reference](https://docs.microsoft.com/en-us/cli/azure/) - Full Azure CLI documentation

### Security Best Practices

- [Least Privilege Principle](https://docs.microsoft.com/en-us/azure/role-based-access-control/best-practices) - Azure RBAC best practices
- [GitHub Actions Security Hardening](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions) - GitHub security guide

### Related Topics

- [Workload Identity Federation](https://docs.microsoft.com/en-us/azure/active-directory/develop/workload-identity-federation) - Deeper dive into the underlying technology
- [Azure Service Principal](https://docs.microsoft.com/en-us/azure/active-directory/develop/app-objects-and-service-principals) - Understanding service principals

---

## Quick Reference

### Required Values Checklist

| Value | Where to Find | Used For |
|-------|---------------|----------|
| Application (Client) ID | `az ad app show --id <app-id> --query appId` | GitHub secret, role assignment |
| Application Object ID | `az ad app show --id <app-id> --query id` | Federated credential creation |
| Tenant ID | `az account show --query tenantId` | GitHub secret |
| Subscription ID | `az account show --query id` | GitHub secret, role assignment |

### Subject Claim Formats

| Trigger | Subject Format |
|---------|----------------|
| Push to branch | `repo:OWNER/REPO:ref:refs/heads/BRANCH` |
| Pull request | `repo:OWNER/REPO:pull_request` |
| Environment | `repo:OWNER/REPO:environment:ENV_NAME` |
| Tag | `repo:OWNER/REPO:ref:refs/tags/TAG` |
| Any ref | `repo:OWNER/REPO:ref:refs/heads/*` (wildcard) |
