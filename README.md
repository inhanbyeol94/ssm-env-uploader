# ssm-env-uploader

A CLI tool to upload environment variables from `.env` files to AWS SSM Parameter Store.

## Features

- **Concurrent Uploads**: Uploads multiple parameters in parallel for faster execution.
- **Download Support**: Retrieve existing parameters from SSM back to local `.env` files using the `--get` flag.
- **Original File Backup**: On every upload, the raw `.env` file (comments and ordering preserved) is stored under `origin/` and can be rebuilt with `--restore`.
- **Sync Support**: Upload local values and remove SSM parameters that no longer exist locally using the `--sync` flag (with confirmation).
- **Secure**: Stores parameters as `SecureString`.
- **Easy Configuration**: Simple JSON configuration file.
- **Profile Support**: Supports AWS CLI profiles.

## Installation

```bash
npm install -g @inhanbyeol/ssm-env-uploader
# or
pnpm add -g @inhanbyeol/ssm-env-uploader
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

### Upload environment variables

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

### Download environment variables

To download environment variables from AWS SSM to your local `.env` file:

```bash
seu <env> --get
```

Example:

```bash
seu dev --get
# Fetching parameters from /your-app-name/dev...
# Successfully downloaded 15 parameters to .env.dev
```

### Restore the original file

`seu <env>` automatically backs up the raw `.env` file to SSM under
`/<basePath>/<env>/origin/` (gzip + base64, split into ≤4000-char chunks, stored
as `SecureString`). Unlike `--get` — which reconstructs `KEY="value"` lines
sorted alphabetically — `--restore` rebuilds the file **exactly**, including
comments and original ordering:

```bash
seu <env> --restore
```

Example:

```bash
seu dev --restore
# Restoring origin file from /your-app-name/dev/origin...
# Successfully restored .env.dev from origin backup
```

Each upload clears the previous origin backup first (delete-then-write), and
`--restore` verifies the chunk count and a `sha256` checksum before writing. The `origin/` chunks are
nested paths, so they are never included in `--get` output nor deleted by
`--sync` orphan detection.

### Sync environment variables

To upload local values **and delete** any SSM parameters that are not present in your local `.env` file:

```bash
seu <env> --sync
```

Example:

```bash
seu dev --sync
# Uploading .env.dev to Parameter Store...
# Upload to Parameter Store completed successfully: /your-app-name/dev (15 items) from .env.dev
#
# Found 2 parameter(s) in SSM not present locally:
#   - OLD_API_KEY
#   - DEPRECATED_TOKEN
# Delete 2 parameter(s) from SSM? (y/N):
```

> [!WARNING]
> `--sync` permanently deletes SSM parameters that are missing locally. A confirmation prompt is shown before any deletion; answer `y` to proceed. Only flat keys directly under the base path are affected — nested parameters (e.g. `/your-app-name/dev/group/KEY`) are left untouched.

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
