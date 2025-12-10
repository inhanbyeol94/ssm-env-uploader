#!/usr/bin/env node

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { execSync, exec } from "node:child_process";
import util from "util";

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
      dev: ".env.development",
      prod: ".env.production",
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

const existsEnvFile = fs.existsSync(
  path.resolve(process.cwd(), targetEnvFileName)
);

if (!existsEnvFile) throw new Error(`${targetEnvFileName} not found`);

const envData = fs.readFileSync(targetEnvFileName);
const envParams = Object.entries(dotenv.parse(envData)).filter(
  ([_, value]) => value
);

const CONCURRENCY = config?.concurrency || 1;
const execPromise = util.promisify(exec);
const startSlash = config.basePath[0] === "/" ? "" : "/";

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

const totalParams = envParams.length;

console.log(
  `\x1b[90mUploading ${targetEnvFileName} to Parameter Store...\x1b[0m`
);

const workers = Array(CONCURRENCY)
  .fill(null)
  .map(async () => {
    while (envParams.length > 0) {
      const item = envParams.shift();
      if (!item) break;
      const [key, value] = item;
      await uploadParameter(key, value);
    }
  });

Promise.all(workers).then(() => {
  console.log(
    `\x1b[32mUpload to Parameter Store completed successfully: ${startSlash}${config.basePath}/${env} (${totalParams} items) from ${targetEnvFileName}\x1b[0m`
  );
});
