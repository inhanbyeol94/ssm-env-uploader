import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { decodeOrigin } from "./origin";

test("CLI uploads bcrypt and shell special characters without changing values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seu-upload-test-"));
  try {
    const binDir = path.join(dir, "bin");
    const capturePath = path.join(dir, "calls.jsonl");
    fs.mkdirSync(binDir);
    const values: Record<string, string> = {
      TEST: "$2a$10$Ajv5PoGr6e0B9n8aD27A1u2fJb25ZtBTE6JtlnFLt2iB316vyAX5G",
      SHELL: "$(printf expanded) `printf expanded` $HOME ; & | < >",
      QUOTES: "double\" single' backslash\\ # equals=",
      MULTILINE: "first line\nsecond line",
    };
    const raw = [
      `TEST=${values.TEST}`,
      `SHELL='${values.SHELL}'`,
      `QUOTES=\`${values.QUOTES}\``,
      `MULTILINE="${values.MULTILINE}"`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, ".env.test"), raw);
    fs.writeFileSync(path.join(dir, "seu-cli.json"), JSON.stringify({
      basePath: "seu-test",
      region: "ap-northeast-2",
      cliProfile: "test-profile",
      concurrency: 2,
      envFile: { test: ".env.test" },
    }));
    // Capture the arguments at the AWS CLI boundary without accessing AWS.
    fs.writeFileSync(path.join(binDir, "aws"), [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.SEU_TEST_CAPTURE, JSON.stringify(args) + '\\n');",
      "console.log(JSON.stringify(args[1] === 'get-parameters-by-path' ? { Parameters: [] } : { Version: 1 }));",
      "",
    ].join("\n"), { mode: 0o755 });

    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      "-r", require.resolve("ts-node/register"),
      path.resolve(__dirname, "main.ts"), "test",
    ], {
      cwd: dir,
      env: {
        ...childEnv,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SEU_TEST_CAPTURE: capturePath,
        TS_NODE_PROJECT: path.resolve(__dirname, "../tsconfig.json"),
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(capturePath), result.stdout + result.stderr);
    const calls: string[][] = fs.readFileSync(capturePath, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const puts = calls.filter((args) => args[1] === "put-parameter");
    const uploaded = new Map(puts.map((args) => {
      assert.equal(args[args.indexOf("--type") + 1], "SecureString");
      assert.equal(args[args.indexOf("--profile") + 1], "test-profile");
      return [args[args.indexOf("--name") + 1], args[args.indexOf("--value") + 1]];
    }));
    for (const [key, value] of Object.entries(values)) {
      assert.equal(uploaded.get(`/seu-test/test/${key}`), value, key);
    }
    assert.equal(puts.length, Object.keys(values).length + 2);
    assert.equal(decodeOrigin(uploaded.get("/seu-test/test/origin/VALUE_0")!).toString(), raw);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
