import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const binPath = packageJson.bin?.["context-overflow"];
if (typeof binPath !== "string") {
  throw new Error("package.json does not declare the context-overflow bin");
}
const result = spawnSync(process.execPath, [binPath, "--help"], {
  stdio: "inherit"
});
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
