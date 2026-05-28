#!/usr/bin/env node

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { execSync, exec } from "node:child_process";
import util from "util";
import readline from "node:readline";
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

const env = process.argv[2];

if (env === "--init") {
  const configPath = path.resolve(process.cwd(), "seu-cli.json");
  if (fs.existsSync(configPath)) {
    console.error("\x1b[31mseu-cli.json already exists\x1b[0m");
    process.exit(1);
  }

  const defaultConfig = {
    basePath: "your-base-path",
    region: "ap-northeast-2",
    cliProfile: "default",
    concurrency: 1,
    envFile: {
      dev: ".env.dev",
      prod: ".env.prod",
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
  console.log("\x1b[32mseu-cli.json created successfully\x1b[0m");
  process.exit(0);
}

const configPath = path.resolve(process.cwd(), "seu-cli.json");

if (!fs.existsSync(configPath))
  throw new Error(`seu.json not found in ${process.cwd()}`);

const configData = fs.readFileSync(configPath, "utf-8");
const config = JSON.parse(configData) as {
  basePath: string;
  cliProfile?: string;
  region: string;
  concurrency?: number;
  envFile: {
    [key: string]: string;
  };
};

if (!config.basePath) throw new Error("basePath is required");
if (!config.envFile) throw new Error("envFile is required");
if (!config.region) throw new Error("region is required");

const targetEnvFileName = config.envFile[env];
if (!targetEnvFileName) throw new Error(`${env} is not found in seu-cli.json`);

const execPromise = util.promisify(exec);
const startSlash = config.basePath[0] === "/" ? "" : "/";

const fullBasePath = `${startSlash}${config.basePath}/${env}`;

const fetchParameters = (nextToken?: string): any[] => {
  const command = [
    "aws ssm get-parameters-by-path",
    `--path "${fullBasePath}/"`,
    "--recursive",
    "--with-decryption",
    `--region "${config.region}"`,
    config.cliProfile ? `--profile ${config.cliProfile}` : "",
    "--output json",
    nextToken ? `--next-token "${nextToken}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const stdout = execSync(command, {
    maxBuffer: 1024 * 1024 * 10,
  });
  const result = JSON.parse(stdout.toString());
  const params = result.Parameters || [];

  if (result.NextToken) {
    return [...params, ...fetchParameters(result.NextToken)];
  }
  return params;
};

if (process.argv[3] === "--get") {
  console.log(`\x1b[90mFetching parameters from ${fullBasePath}...\x1b[0m`);

  try {
    const parameters = fetchParameters();
    parameters.sort((a: any, b: any) => a.Name.localeCompare(b.Name));

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
    process.exit(0);
  } catch (err: any) {
    console.error("\x1b[31mFailed to fetch parameters\x1b[0m", err);
    process.exit(1);
  }
}

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
      if (meta.chunks !== chunkValues.length) {
        console.error(
          `\x1b[31mIntegrity check failed: META declares ${meta.chunks} chunk(s) but found ${chunkValues.length}. File not written.\x1b[0m`
        );
        process.exit(1);
      }
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
    const detail = err?.stderr
      ? (err.stderr as Buffer).toString()
      : err?.message ?? err;
    console.error("\x1b[31mFailed to restore origin file\x1b[0m", detail);
    process.exit(1);
  }
}

const existsEnvFile = fs.existsSync(
  path.resolve(process.cwd(), targetEnvFileName)
);

if (!existsEnvFile) throw new Error(`${targetEnvFileName} not found`);

const envData = fs.readFileSync(targetEnvFileName);
const parsedEnv = dotenv.parse(envData);
const localKeys = new Set(Object.keys(parsedEnv));
const envParams = Object.entries(parsedEnv).filter(
  ([_, value]) => value
) as [string, string][];

const CONCURRENCY = config?.concurrency || 1;
const isSync = process.argv[3] === "--sync";

const uploadParameter = async (key: string, value: string) => {
  const paramName = `${startSlash}${config.basePath}/${env}/${key}`;
  const command = `
  aws ssm put-parameter \
   --name "${paramName}" \
   --value "${value}" \
   --type "SecureString" \
   --overwrite \
   --region  "${config.region}" \
   ${config.cliProfile ? `--profile ${config.cliProfile}` : ""}`;

  try {
    await execPromise(command);
  } catch (err: any) {
    if (err.stderr) {
      console.error(
        `${paramName} sync failed:`,
        (err.stderr as Buffer).toString()
      );
    } else {
      console.error(`${paramName} sync failed:`, err);
    }
  }
};

const uploadAll = async (params: [string, string][]) => {
  const queue = [...params];
  const workers = Array(CONCURRENCY)
    .fill(null)
    .map(async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        const [key, value] = item;
        await uploadParameter(key, value);
      }
    });
  await Promise.all(workers);
};

const backupOrigin = async (): Promise<number> => {
  // Reuse the file buffer already loaded at startup — avoids a redundant
  // disk read and the TOCTOU window between flat-key upload and backup.
  const raw = envData;
  const encoded = encodeOrigin(raw);
  const chunks = splitChunks(encoded);
  const hash = sha256Hex(raw);

  // delete-then-write: remove ALL existing origin params first so no stale
  // chunk from a previous (larger) upload can corrupt a later restore.
  // Errors here MUST propagate — silent cleanup failure would defeat the
  // delete-then-write guarantee.
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

  const originParams: [string, string][] = chunks.map((chunk, i) => [
    `origin/VALUE_${i}`,
    chunk,
  ]);
  originParams.push(["origin/META", buildMetaValue(chunks.length, hash)]);
  await uploadAll(originParams);

  return chunks.length;
};

(async () => {
  const totalParams = envParams.length;

  console.log(
    `\x1b[90mUploading ${targetEnvFileName} to Parameter Store...\x1b[0m`
  );

  await uploadAll(envParams);

  console.log(
    `\x1b[32mUpload to Parameter Store completed successfully: ${fullBasePath} (${totalParams} items) from ${targetEnvFileName}\x1b[0m`
  );

  const originChunkCount = await backupOrigin();
  console.log(
    `\x1b[32mOrigin backup stored at ${fullBasePath}/origin (${originChunkCount} chunk(s))\x1b[0m`
  );

  if (!isSync) process.exit(0);

  let ssmParams: any[];
  try {
    ssmParams = fetchParameters();
  } catch (err: any) {
    console.error(
      "\x1b[31mFailed to fetch parameters for sync\x1b[0m",
      err
    );
    process.exit(1);
  }

  const orphans = ssmParams
    .map((param: any) => ({
      name: param.Name as string,
      key: param.Name.split(`${fullBasePath}/`)[1] as string | undefined,
    }))
    .filter(
      (entry) =>
        !!entry.key && !entry.key.includes("/") && !localKeys.has(entry.key)
    );

  if (orphans.length === 0) {
    console.log(
      "\x1b[32mNo parameters to delete. SSM is in sync with local.\x1b[0m"
    );
    process.exit(0);
  }

  console.log(
    `\n\x1b[33mFound ${orphans.length} parameter(s) in SSM not present locally:\x1b[0m`
  );
  orphans.forEach((entry) => {
    console.log(`  - ${entry.key}`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `Delete ${orphans.length} parameter(s) from SSM? (y/N): `,
      resolve
    );
  });
  rl.close();

  if (answer.trim().toLowerCase() !== "y") {
    console.log("\x1b[90mDeletion skipped.\x1b[0m");
    process.exit(0);
  }

  const names = orphans.map((entry) => entry.name);
  let deletedCount = 0;
  for (let i = 0; i < names.length; i += 10) {
    const batch = names.slice(i, i + 10);
    const command = [
      "aws ssm delete-parameters",
      `--names ${batch.map((n) => `"${n}"`).join(" ")}`,
      `--region "${config.region}"`,
      config.cliProfile ? `--profile ${config.cliProfile}` : "",
      "--output json",
    ]
      .filter(Boolean)
      .join(" ");

    try {
      const stdout = execSync(command, { maxBuffer: 1024 * 1024 * 10 });
      const result = JSON.parse(stdout.toString());
      deletedCount += (result.DeletedParameters || []).length;
      if (result.InvalidParameters && result.InvalidParameters.length > 0) {
        console.error(
          `\x1b[31mFailed to delete: ${result.InvalidParameters.join(", ")}\x1b[0m`
        );
      }
    } catch (err: any) {
      console.error("\x1b[31mDelete failed\x1b[0m", err);
    }
  }

  console.log(
    `\x1b[32mDeleted ${deletedCount} parameter(s) from SSM.\x1b[0m`
  );
  process.exit(0);
})();
