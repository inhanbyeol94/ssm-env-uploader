# Origin File Backup & Restore — Design

Date: 2026-05-28
Package: `@inhanbyeol/ssm-env-uploader`

## Problem

`seu <env> --get` reconstructs a `.env` file from individual SSM parameters, but
it writes `KEY="value"` lines sorted alphabetically. Comments and original line
order are lost. There is no way to recover the exact original file.

## Goal

On every upload, also store the **raw env file** (bytes-for-bytes, including
comments and ordering) in SSM, and provide a `--restore` command that rebuilds
the exact original file locally.

## SSM Parameter Layout

The raw file is stored under an `origin/` sub-path so it never collides with the
flat keys and is naturally excluded from `--get`/`--sync` (both already skip keys
containing `/`):

```
/basePath/env/KEY1                 flat key (current behavior)
/basePath/env/KEY2
/basePath/env/origin/VALUE_0       gzip+base64 chunk (<= 4000 chars)
/basePath/env/origin/VALUE_1
/basePath/env/origin/META          {"chunks":2,"sha256":"...","encoding":"gzip+base64"}
```

- All `origin/*` parameters are `SecureString` (the env file may contain secrets).
- Chunk value limit: SSM Standard tier caps a parameter value at 4096 chars, so
  each chunk holds at most **4000 chars** of the base64 string for safety margin.
- `VALUE_<n>` is 0-based; `n` is parsed as an integer for ordering (no
  zero-padding required).

### META contents

```json
{
  "chunks": 2,
  "sha256": "<hex sha256 of the ORIGINAL raw file bytes>",
  "encoding": "gzip+base64"
}
```

`sha256` is computed over the original file bytes (before gzip), so `--restore`
can verify the fully decoded+decompressed output matches.

## Encoding

`gzip(rawFileBytes)` → `base64`. Uses Node's built-in `zlib` (`gzipSync` /
`gunzipSync`) — no new dependencies. gzip first keeps the chunk count low for
typical env files.

## Upload Flow — `seu <env>` and `seu <env> --sync`

Origin backup runs on **every** upload (both plain and `--sync`), after the
existing flat-key upload:

1. Upload flat keys (unchanged from current behavior).
2. Read the raw env file bytes (do **not** `dotenv.parse` — preserve comments
   and order).
3. `gzip` then `base64` the bytes; compute `sha256` of the raw bytes.
4. **Delete-then-write**: list all existing parameters under
   `/basePath/env/origin/` and delete them all (skip if none). This guarantees no
   stale chunks remain from a previous, larger upload.
5. Split the base64 string into 4000-char chunks; upload as
   `origin/VALUE_0 … origin/VALUE_{N-1}` (SecureString).
6. Upload `origin/META` with `{chunks: N, sha256, encoding}` (SecureString).

Step 4's deletion is independent of `--sync`'s flat-key orphan deletion. For
`--sync`, origin backup happens before the flat-key orphan-detection/prompt step;
origin params are never treated as orphans (they contain `/`).

Deletion reuses the existing batched `aws ssm delete-parameters` pattern
(10 names per call).

## `--get` Change

Current `--get` writes every recursive parameter, including nested ones, as
literal `origin/VALUE_0="..."` lines — a bug. Fix: **skip any parameter whose key
(the part after `/basePath/env/`) contains `/`**, matching the `--sync` orphan
rule (current line 207). Result: `--get` downloads only the flat keys, cleanly.

## `--restore` (new flag)

`seu <env> --restore`:

1. Fetch all parameters under `/basePath/env/origin/`.
2. If no `VALUE_*` chunks exist: print a friendly message
   ("No origin backup found. Run `seu <env>` first to upload.") and exit 0.
3. Extract `VALUE_<n>` params, sort by integer `n`, concatenate their values.
4. `base64`-decode → `gunzip` → raw file bytes.
5. If `META` is present, verify `sha256(rawBytes)` matches `META.sha256`. On
   mismatch, error out **without** writing the file (exit 1).
6. Write the raw bytes to `targetEnvFileName`, overwriting (consistent with
   `--get`; no confirmation prompt).

`--restore` is mutually exclusive with `--get`/`--sync` (it is a distinct
`process.argv[3]` branch).

## Error Handling

- gzip/gunzip or base64 decode failure → print error, exit 1, do not write file.
- sha256 mismatch → error, exit 1, do not write file.
- Missing origin chunks on `--restore` → friendly notice, exit 0.
- Origin upload failures (put/delete) → reuse existing per-command error logging;
  flat-key upload success is reported independently.

## Out of Scope

- Restoring flat keys and origin in a single command.
- Advanced-tier (>4096) single-parameter storage.
- Compression algorithm choice / configurability (gzip fixed).

## Affected Code

Single file: `src/main.ts`. Add an `--restore` branch, an origin-upload routine
invoked from the existing upload IIFE, a `/`-key filter in `--get`. Update
`README.md` and any inline help.
