import { createHash } from "node:crypto";

export function sha256Base64Url(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

export function sha256Text(value: string): string {
  return sha256Base64Url(Buffer.from(value, "utf8"));
}

export function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(
    13,
    16
  )}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
