import {
  mkdirSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

const files: Readonly<Record<string, string>> = {
  "cq01-source-match/inventory-reconciler.ts":
    "export function reconcile(value: number) { return value + 1; }\n",
  "cq01-source-match/request.txt":
    "Locate this exact source:\n```ts\nexport function reconcile(value: number) { return value + 1; }\n```",
  "cq02-diagnostics/request.txt": [
    "FAIL tests/a.test.ts > suite > case",
    "Expected: 2",
    "Received: 1",
    "TypeError [ERR_TEST_FAILURE]: invented",
    "    at run (src/a.ts:2:3)",
    "Process exited with code 1",
    ""
  ].join("\n"),
  "cq03-incomplete/request.txt":
    "A failure occurred but the detailed failure block is missing.\n",
  "cq03-incomplete/complete-follow-up.txt":
    "Complete invented failure evidence with exact bounded detail.\n",
  "cq04-repetition/request.txt":
    `header\n${"repeated invented line\n".repeat(120)}footer\n`,
  "cq05-source-scope/request.txt": [
    "function helper() { return 42; }",
    "export function run() { return helper(); }",
    "export const unrelated = 7;",
    ""
  ].join("\n"),
  "cq06-missing-fact/checkout-events.jsonl":
    '{"event":"invented"}\n',
  "cq06-missing-fact/missing-response.txt":
    "Request failed without the observed contract fact.\n",
  "cq06-missing-fact/observed-response.txt":
    "Request failed. status=503 body=invented-error correlationId=cid-demo Error\n",
  "cq06-missing-fact/response-observation.json":
    '{"status":503,"body":"invented-error","correlationId":"cid-demo"}',
  "cq07-source-version/changed-config.txt":
    "Captured and current snapshots differ.\n",
  "cq07-source-version/dispatch-worker.captured.json":
    '{"enabled":false}\n',
  "cq07-source-version/dispatch-worker.current.json":
    '{"enabled":true}\n',
  "mf01-exact-operation/prompt.txt":
    "Perform an exact deterministic operation.\n",
  "mf02-routine/prompt.txt":
    "Perform a bounded routine operation.\n",
  "mf03-reasoning/prompt.txt":
    "Perform a reasoning-intensive operation.\n",
  "luna/prompt.txt":
    "Suggest evidence gaps only for this invented task.\n"
};

export function writeManualBenchmarkFixture(
  root: string,
  overrides: Readonly<Record<string, string>> = {}
): void {
  for (const [relativePath, contents] of Object.entries({
    ...files,
    ...overrides
  })) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }
}
