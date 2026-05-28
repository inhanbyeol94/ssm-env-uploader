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

/** Parse an origin/META value back into an OriginMeta object. Throws on malformed input. */
export function parseMeta(value: string): OriginMeta {
  const decoded = Buffer.from(value, "base64").toString("utf-8");
  const parsed: unknown = JSON.parse(decoded);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { chunks?: unknown }).chunks !== "number" ||
    typeof (parsed as { sha256?: unknown }).sha256 !== "string" ||
    typeof (parsed as { encoding?: unknown }).encoding !== "string"
  ) {
    throw new Error("origin/META is malformed");
  }
  return parsed as OriginMeta;
}
