import { test } from "node:test";
import assert from "node:assert";
import {
  encodeOrigin,
  decodeOrigin,
  splitChunks,
  sha256Hex,
  CHUNK_SIZE,
  orderChunkValues,
  isFlatKey,
  buildMetaValue,
  parseMeta,
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
