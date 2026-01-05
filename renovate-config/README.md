# Renovate Configuration

This directory contains the shared Renovate configuration for .NET projects.

## Usage

To use this configuration in your project, create a `renovate.json` file in the root of your repository with the following content:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "github>jules-labs/jules-project/renovate-config"
  ]
}
```

### Extending and Overriding Presets

You can extend the provided presets and override the configuration as needed. For example, to use the `.NET` preset and add a custom package rule, you can do the following:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "github>jules-labs/jules-project/renovate-config",
    "github>jules-labs/jules-project/renovate-config:presets/dotnet"
  ],
  "packageRules": [
    {
      "matchPackagePatterns": [
        "*"
      ],
      "groupName": "all packages"
    }
  ]
}
```

## Documentation

For more information on how to configure Renovate, please refer to the [official Renovate documentation](https://docs.renovatebot.com/).
