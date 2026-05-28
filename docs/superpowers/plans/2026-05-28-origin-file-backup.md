# Origin File Backup & Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the raw `.env` file (comments + order preserved) in SSM as gzip+base64 chunks on every upload, and add a `seu <env> --restore` command that rebuilds the exact original file.

**Architecture:** Extract pure, unit-testable helpers (encode/decode/chunk/hash/order/filter/meta) into `src/origin.ts`. Wire them into the existing procedural `src/main.ts`: filter nested keys out of `--get`, run a delete-then-write origin backup after every flat-key upload, and add a `--restore` branch. AWS access stays as `aws` CLI shell-outs (unchanged pattern).

**Tech Stack:** TypeScript (commonjs), Node 24 built-ins (`zlib`, `crypto`), `node:test` + `ts-node/register` for tests. No new dependencies.

---

## File Structure

- **Create `src/origin.ts`** — pure functions: `encodeOrigin`, `decodeOrigin`, `splitChunks`, `sha256Hex`, `orderChunkValues`, `isFlatKey`, `buildMetaValue`, `parseMeta`, plus `CHUNK_SIZE`/`ENCODING` constants. No I/O, no AWS. Fully unit-tested.
- **Create `src/origin.test.ts`** — `node:test` suite for `src/origin.ts`.
- **Modify `src/main.ts`** — import helpers; add `isFlatKey` filter to `--get`; add `backupOrigin()` and call it in the upload IIFE; add `--restore` branch.
- **Modify `package.json`** — real `test` script.
- **Modify `tsconfig.json`** — exclude `*.test.ts` from the build.
- **Modify `README.md`** — document automatic origin backup and `--restore`.

### Key design notes (shared by multiple tasks)

- Chunk parameters: `/basePath/env/origin/VALUE_<n>` (0-based, `SecureString`), each ≤ 4000 chars of the base64 string.
- Meta parameter: `/basePath/env/origin/META`, value is **base64-encoded JSON** `{chunks,sha256,encoding}`. Base64 transport avoids shell-quoting issues with JSON double-quotes in `--value`.
- `sha256` is over the **original raw bytes** (before gzip), so `--restore` can verify the decoded output.
- `key` always means the substring after `` `${fullBasePath}/` `` — e.g. `"API_KEY"` (flat) or `"origin/VALUE_0"` (nested).
- Reused from existing code: `fetchParameters()`, `uploadAll()`/`uploadParameter()`, and the batched `aws ssm delete-parameters` pattern (10 names per call).

---

## Task 1: Test infrastructure

**Files:**
- Modify: `package.json` (the `scripts.test` line)
- Modify: `tsconfig.json` (the `exclude` array)

- [ ] **Step 1: Add the test script**

In `package.json`, replace the `test` script:

```json
  "scripts": {
    "build": "tsc",
    "test": "node -r ts-node/register --test src/*.test.ts"
  },
```

- [ ] **Step 2: Exclude test files from the build**

In `tsconfig.json`, update `exclude` so test files never land in `dist/` (and thus never ship to npm):

```json
  "exclude": ["node_modules", "src/**/*.test.ts"]
```

- [ ] **Step 3: Verify the runner finds no test files yet (or errors cleanly)**

Run: `npm test`
Expected: command runs `node --test`; since no `src/*.test.ts` exists yet, the shell glob is literal and Node reports it cannot find the test file (non-zero exit). This is fine — Task 2 creates the first test. Do not treat this as a blocker.

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.json
git commit -m "chore: add node:test runner script and exclude tests from build"
```

---

## Task 2: Encoding helpers in `src/origin.ts`

**Files:**
- Create: `src/origin.ts`
- Create (test): `src/origin.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/origin.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert";
import {
  encodeOrigin,
  decodeOrigin,
  splitChunks,
  sha256Hex,
  CHUNK_SIZE,
} from "./origin";

test("encodeOrigin/decodeOrigin round-trips raw bytes", () => {
  const raw = Buffer.from("# comment\nA=1\nB=2\n");
  const encoded = encodeOrigin(raw);
  assert.strictEqual(typeof encoded, "string");
  assert.ok(encoded.length > 0);
  assert.deepStrictEqual(decodeOrigin(encoded), raw);
});

test("splitChunks splits by size and rejoins losslessly", () => {
  const s = "abcdefghij";
  assert.deepStrictEqual(splitChunks(s, 4), ["abcd", "efgh", "ij"]);
  assert.strictEqual(splitChunks(s, 4).join(""), s);
});

test("splitChunks default size is 4000", () => {
  const s = "x".repeat(9001);
  const chunks = splitChunks(s);
  assert.strictEqual(CHUNK_SIZE, 4000);
  assert.strictEqual(chunks.length, 3);
  assert.strictEqual(chunks[0].length, 4000);
  assert.strictEqual(chunks[2].length, 9001 - 8000);
});

test("sha256Hex matches the known empty-input digest", () => {
  assert.strictEqual(
    sha256Hex(Buffer.from("")),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});

test("full data path: encode -> split -> join -> decode preserves bytes & hash", () => {
  const raw = Buffer.from("# header line\n".repeat(2000) + "KEY=value\n");
  const hash = sha256Hex(raw);
  const chunks = splitChunks(encodeOrigin(raw));
  assert.ok(chunks.length >= 1);
  const restored = decodeOrigin(chunks.join(""));
  assert.deepStrictEqual(restored, raw);
  assert.strictEqual(sha256Hex(restored), hash);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './origin'` (the module does not exist yet).

- [ ] **Step 3: Implement the encoding helpers**

Create `src/origin.ts`:

```ts
import zlib from "node:zlib";
import crypto from "node:crypto";

export const CHUNK_SIZE = 4000;
export const ENCODING = "gzip+base64";

/** gzip the raw file bytes, then base64-encode. */
export function encodeOrigin(raw: Buffer): string {
  return zlib.gzipSync(raw).toString("base64");
}

/** Reverse of encodeOrigin: base64-decode, then gunzip back to raw bytes. */
export function decodeOrigin(encoded: string): Buffer {
  return zlib.gunzipSync(Buffer.from(encoded, "base64"));
}

/** Split a string into <= size pieces; join("") restores the original. */
export function splitChunks(value: string, size: number = CHUNK_SIZE): string[] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += size) {
    chunks.push(value.slice(i, i + size));
  }
  return chunks;
}

/** Hex sha256 of raw bytes (computed over the ORIGINAL file, pre-gzip). */
export function sha256Hex(raw: Buffer): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/origin.ts src/origin.test.ts
git commit -m "feat: add origin encoding/chunking/hash helpers"
```

---

## Task 3: Ordering, key filter, and META helpers in `src/origin.ts`

**Files:**
- Modify: `src/origin.ts`
- Modify (test): `src/origin.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/origin.test.ts`:

```ts
import {
  orderChunkValues,
  isFlatKey,
  buildMetaValue,
  parseMeta,
} from "./origin";

test("orderChunkValues keeps only chunks, ordered by numeric index", () => {
  const entries = [
    { key: "origin/VALUE_10", value: "k" },
    { key: "API_KEY", value: "secret" },
    { key: "origin/VALUE_2", value: "c" },
    { key: "origin/META", value: "m" },
    { key: "origin/VALUE_0", value: "a" },
  ];
  assert.deepStrictEqual(orderChunkValues(entries), ["a", "c", "k"]);
});

test("orderChunkValues returns [] when there are no chunks", () => {
  assert.deepStrictEqual(
    orderChunkValues([{ key: "API_KEY", value: "x" }]),
    []
  );
});

test("isFlatKey accepts top-level keys, rejects nested and empty", () => {
  assert.strictEqual(isFlatKey("API_KEY"), true);
  assert.strictEqual(isFlatKey("origin/VALUE_0"), false);
  assert.strictEqual(isFlatKey("origin/META"), false);
  assert.strictEqual(isFlatKey(""), false);
});

test("buildMetaValue/parseMeta round-trip through base64 JSON", () => {
  const value = buildMetaValue(3, "deadbeef");
  const meta = parseMeta(value);
  assert.strictEqual(meta.chunks, 3);
  assert.strictEqual(meta.sha256, "deadbeef");
  assert.strictEqual(meta.encoding, "gzip+base64");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `orderChunkValues`/`isFlatKey`/`buildMetaValue`/`parseMeta` are not exported yet.

- [ ] **Step 3: Implement the helpers**

Append to `src/origin.ts`:

```ts
export interface OriginMeta {
  chunks: number;
  sha256: string;
  encoding: string;
}

const CHUNK_KEY_RE = /^origin\/VALUE_(\d+)$/;

/**
 * From SSM entries (key relative to `${fullBasePath}/`), return the chunk
 * values ordered by their numeric index. Non-chunk entries are ignored.
 */
export function orderChunkValues(
  entries: { key: string; value: string }[]
): string[] {
  const chunks: { index: number; value: string }[] = [];
  for (const entry of entries) {
    const match = CHUNK_KEY_RE.exec(entry.key);
    if (match) chunks.push({ index: parseInt(match[1], 10), value: entry.value });
  }
  chunks.sort((a, b) => a.index - b.index);
  return chunks.map((c) => c.value);
}

/** True only for top-level keys (no "/"), used to keep `--get` flat. */
export function isFlatKey(key: string): boolean {
  return !!key && !key.includes("/");
}

/** Build the origin/META value: base64-encoded JSON (shell-quote safe). */
export function buildMetaValue(chunks: number, sha256: string): string {
  const meta: OriginMeta = { chunks, sha256, encoding: ENCODING };
  return Buffer.from(JSON.stringify(meta)).toString("base64");
}

/** Parse an origin/META value back into an OriginMeta object. */
export function parseMeta(value: string): OriginMeta {
  return JSON.parse(Buffer.from(value, "base64").toString("utf-8")) as OriginMeta;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 9 tests total pass.

- [ ] **Step 5: Commit**

```bash
git add src/origin.ts src/origin.test.ts
git commit -m "feat: add chunk ordering, flat-key filter, and META helpers"
```

---

## Task 4: Filter nested keys out of `--get`

**Files:**
- Modify: `src/main.ts` (imports near line 8; `--get` block lines 96-110)

- [ ] **Step 1: Add the import**

After the existing imports (after `import readline from "node:readline";`, line 8), add:

```ts
import {
  encodeOrigin,
  decodeOrigin,
  splitChunks,
  sha256Hex,
  orderChunkValues,
  isFlatKey,
  buildMetaValue,
  parseMeta,
} from "./origin";
```

- [ ] **Step 2: Filter the `--get` output to flat keys only**

Replace this block (current lines 96-110):

```ts
    const envContent = parameters
      .map((param: any) => {
        const key = param.Name.split(`${fullBasePath}/`)[1];
        const value = param.Value.replace(/\n/g, "\\n");
        return `${key}="${value}"`;
      })
      .join("\n");

    fs.writeFileSync(
      path.resolve(process.cwd(), targetEnvFileName),
      envContent
    );
    console.log(
      `\x1b[32mSuccessfully downloaded ${parameters.length} parameters to ${targetEnvFileName}\x1b[0m`
    );
```

with:

```ts
    const flatParams = parameters.filter((param: any) =>
      isFlatKey(param.Name.split(`${fullBasePath}/`)[1])
    );

    const envContent = flatParams
      .map((param: any) => {
        const key = param.Name.split(`${fullBasePath}/`)[1];
        const value = param.Value.replace(/\n/g, "\\n");
        return `${key}="${value}"`;
      })
      .join("\n");

    fs.writeFileSync(
      path.resolve(process.cwd(), targetEnvFileName),
      envContent
    );
    console.log(
      `\x1b[32mSuccessfully downloaded ${flatParams.length} parameters to ${targetEnvFileName}\x1b[0m`
    );
```

- [ ] **Step 3: Type-check and build**

Run: `npx tsc --noEmit`
Expected: no output, exit 0 (the `parseMeta`/`encodeOrigin` etc. imports are unused so far; that is allowed because `noUnusedLocals` is not enabled — confirm there are NO errors).

- [ ] **Step 4: Confirm unit tests still pass**

Run: `npm test`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "fix: exclude nested (origin) keys from --get output"
```

---

## Task 5: Origin backup on every upload (delete-then-write)

**Files:**
- Modify: `src/main.ts` (add `backupOrigin` after `uploadAll`, ~line 172; call it inside the IIFE before the `--sync` branch, ~line 187)

- [ ] **Step 1: Add the `backupOrigin` function**

Immediately after the `uploadAll` function definition (after its closing `};`, current line 172), insert:

```ts
const backupOrigin = async (): Promise<number> => {
  const raw = fs.readFileSync(path.resolve(process.cwd(), targetEnvFileName));
  const encoded = encodeOrigin(raw);
  const chunks = splitChunks(encoded);
  const hash = sha256Hex(raw);

  // delete-then-write: remove ALL existing origin params first so no stale
  // chunk from a previous (larger) upload can corrupt a later restore.
  try {
    const existing = fetchParameters();
    const originNames: string[] = existing
      .map((param: any) => ({
        name: param.Name as string,
        key: param.Name.split(`${fullBasePath}/`)[1] as string | undefined,
      }))
      .filter((e: { key?: string }) => !!e.key && e.key.startsWith("origin/"))
      .map((e: { name: string }) => e.name);

    for (let i = 0; i < originNames.length; i += 10) {
      const batch = originNames.slice(i, i + 10);
      const command = [
        "aws ssm delete-parameters",
        `--names ${batch.map((n) => `"${n}"`).join(" ")}`,
        `--region "${config.region}"`,
        config.cliProfile ? `--profile ${config.cliProfile}` : "",
        "--output json",
      ]
        .filter(Boolean)
        .join(" ");
      execSync(command, { maxBuffer: 1024 * 1024 * 10 });
    }
  } catch (err: any) {
    console.error(
      "\x1b[33mWarning: failed to clear existing origin params; restore relies on the sha256 integrity check.\x1b[0m"
    );
  }

  const originParams: [string, string][] = chunks.map((chunk, i) => [
    `origin/VALUE_${i}`,
    chunk,
  ]);
  originParams.push(["origin/META", buildMetaValue(chunks.length, hash)]);
  await uploadAll(originParams);

  return chunks.length;
};
```

- [ ] **Step 2: Call `backupOrigin` after the flat-key upload**

In the IIFE, find the success log followed by the sync guard (current lines 183-187):

```ts
  console.log(
    `\x1b[32mUpload to Parameter Store completed successfully: ${fullBasePath} (${totalParams} items) from ${targetEnvFileName}\x1b[0m`
  );

  if (!isSync) process.exit(0);
```

Insert the origin backup between them:

```ts
  console.log(
    `\x1b[32mUpload to Parameter Store completed successfully: ${fullBasePath} (${totalParams} items) from ${targetEnvFileName}\x1b[0m`
  );

  const originChunkCount = await backupOrigin();
  console.log(
    `\x1b[32mOrigin backup stored at ${fullBasePath}/origin (${originChunkCount} chunk(s))\x1b[0m`
  );

  if (!isSync) process.exit(0);
```

- [ ] **Step 3: Type-check and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors, exit 0. `dist/main.js` and `dist/origin.js` are produced; no `*.test.js` appears in `dist/`.

- [ ] **Step 4: Confirm no test files leaked into the build**

Run: `ls dist`
Expected: contains `main.js` and `origin.js`; does NOT contain `origin.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: back up raw env file to origin/ on every upload"
```

---

## Task 6: `--restore` command

**Files:**
- Modify: `src/main.ts` (insert a new branch after the `--get` block, before `const existsEnvFile`, current line 117)

- [ ] **Step 1: Add the `--restore` branch**

Directly after the closing `}` of the `if (process.argv[3] === "--get") { ... }` block (current line 116) and before `const existsEnvFile = ...` (current line 118), insert:

```ts
if (process.argv[3] === "--restore") {
  console.log(
    `\x1b[90mRestoring origin file from ${fullBasePath}/origin...\x1b[0m`
  );

  try {
    const parameters = fetchParameters();
    const entries = parameters
      .map((param: any) => ({
        key: param.Name.split(`${fullBasePath}/`)[1] as string | undefined,
        value: param.Value as string,
      }))
      .filter((e: { key?: string }) => !!e.key) as {
      key: string;
      value: string;
    }[];

    const chunkValues = orderChunkValues(entries);
    if (chunkValues.length === 0) {
      console.log(
        "\x1b[33mNo origin backup found. Run `seu <env>` first to upload.\x1b[0m"
      );
      process.exit(0);
    }

    const raw = decodeOrigin(chunkValues.join(""));

    const metaEntry = entries.find((e) => e.key === "origin/META");
    if (metaEntry) {
      const meta = parseMeta(metaEntry.value);
      const actual = sha256Hex(raw);
      if (actual !== meta.sha256) {
        console.error(
          `\x1b[31mIntegrity check failed: sha256 mismatch (expected ${meta.sha256}, got ${actual}). File not written.\x1b[0m`
        );
        process.exit(1);
      }
    }

    fs.writeFileSync(path.resolve(process.cwd(), targetEnvFileName), raw);
    console.log(
      `\x1b[32mSuccessfully restored ${targetEnvFileName} from origin backup\x1b[0m`
    );
    process.exit(0);
  } catch (err: any) {
    console.error("\x1b[31mFailed to restore origin file\x1b[0m", err);
    process.exit(1);
  }
}
```

- [ ] **Step 2: Type-check and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors, exit 0. All imported helpers (`encodeOrigin`, `decodeOrigin`, `splitChunks`, `sha256Hex`, `orderChunkValues`, `isFlatKey`, `buildMetaValue`, `parseMeta`) are now used.

- [ ] **Step 3: Confirm unit tests still pass**

Run: `npm test`
Expected: PASS — 9 tests.

- [ ] **Step 4: Manual smoke check (no AWS required)**

Run: `node dist/main.js dev --restore` from a directory **without** `seu-cli.json`.
Expected: throws `seu.json not found in ...` (proves the new branch is wired after config loading and doesn't crash at import/parse time). Full AWS round-trip verification requires the user's configured environment.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: add --restore to rebuild original env file from origin backup"
```

---

## Task 7: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add origin backup to the Features list**

In the `## Features` list, add a bullet:

```markdown
- **Original File Backup**: On every upload, the raw `.env` file (comments and ordering preserved) is stored under `origin/` and can be rebuilt with `--restore`.
```

- [ ] **Step 2: Document `--restore` in Usage**

After the `### Download environment variables` section, add:

````markdown
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
`--restore` verifies a `sha256` checksum before writing. The `origin/` chunks are
nested paths, so they are never included in `--get` output nor deleted by
`--sync` orphan detection.
````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document origin backup and --restore"
```

---

## Self-Review Notes (verified during planning)

- **Spec coverage:** layout (Tasks 5/6), gzip+base64 encoding (Task 2), 4000-char chunks (Task 2), delete-then-write (Task 5), META with sha256 (Tasks 3/5/6), `--get` nested-key exclusion (Task 4), `--restore` with integrity check + friendly empty/notice + overwrite (Task 6), no new deps (Task 2), README (Task 7) — all mapped.
- **Naming consistency:** `encodeOrigin`/`decodeOrigin`/`splitChunks`/`sha256Hex`/`orderChunkValues`/`isFlatKey`/`buildMetaValue`/`parseMeta` are used with identical signatures across Tasks 2-6.
- **Deviation from spec (intentional):** META value is transported as **base64-encoded JSON** (not raw JSON) to avoid `--value "..."` shell-quoting issues; semantics are unchanged.
- **Known limitation (documented in Task 5):** if origin cleanup fails, the upload still writes fresh chunks; a stale higher-index chunk would be caught by the `--restore` sha256 check (refuses to write) rather than silently producing a wrong file.
