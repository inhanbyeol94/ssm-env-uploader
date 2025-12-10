# ssm-env-uploader

A CLI tool to upload environment variables from `.env` files to AWS SSM Parameter Store.

## Features

- **Concurrent Uploads**: Uploads multiple parameters in parallel for faster execution.
- **Secure**: Stores parameters as `SecureString`.
- **Easy Configuration**: Simple JSON configuration file.
- **Profile Support**: Supports AWS CLI profiles.

## Installation

```bash
npm install -g ssm-env-uploader
# or
pnpm add -g ssm-env-uploader
```

## Initialization

Run the init command to generate a default configuration file (`seu-cli.json`) in your project root:

```bash
seu --init
```

## Configuration

The tool uses `seu-cli.json` for configuration.

```json
{
  "basePath": "your-app-name",
  "region": "ap-northeast-2",
  "cliProfile": "default",
  "concurrency": 5,
  "envFile": {
    "dev": ".env.dev",
    "prod": ".env.prod"
  }
}
```

- **basePath**: The prefix for your SSM parameters (e.g., `/your-app-name`).
- **region**: AWS region (e.g., `ap-northeast-2`).
- **cliProfile**: (Optional) AWS CLI profile to use.
- **concurrency**: (Optional) Number of parallel uploads (default: 1).
- **envFile**: Mapping of environment names to `.env` file paths.

## Usage

To upload environment variables for a specific environment:

```bash
seu <env>
```

Example:

```bash
seu dev
# Uploading .env.dev to Parameter Store...
# ...
# Upload to Parameter Store completed successfully: /your-app-name/dev (15 items) from .env.dev
```

## Important Notes

> [!WARNING] > **AWS CLI Requirement**: The `aws` command line interface must be installed and available in your system path.

> [!IMPORTANT] > **Credential Management**:
> If the `.env` file you are uploading contains `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`:
>
> - We **strongly recommend** setting the `cliProfile` in your `seu-cli.json`. This ensures the upload is performed using the specific permissions associated with that profile.
> - If `cliProfile` is NOT set, there is a risk that the AWS CLI might attempt to use the credentials found in your `.env` file (if they explicitly override the environment), potentially leading to authentication with the wrong account or insufficient permissions.

## Prerequisites

- AWS CLI must be installed and configured.
- The AWS user must have permissions to put parameters in SSM.
