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
