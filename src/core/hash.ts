import { createHash } from "node:crypto";

export function sha256Base64Url(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

export function sha256Text(value: string): string {
  return sha256Base64Url(Buffer.from(value, "utf8"));
}

