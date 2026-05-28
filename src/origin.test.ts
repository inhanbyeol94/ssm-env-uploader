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
