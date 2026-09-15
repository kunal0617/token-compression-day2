import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { prepareContext } from "../src/pipeline/prepare.js";

const composite = await readFile(
  resolve("fixtures\\composite-demo.log"),
  "utf8"
);
const repetitive = [
  "$ npm test",
  "Restored package cache entry for checkout-service\n".repeat(500),
  composite
].join("\n");
const storePath = resolve(
  join(".context-overflow", `evaluation-${Date.now()}.sqlite`)
);

const result = await prepareContext({
  promptFile: resolve("fixtures\\composite-demo.prompt.txt"),
  contextTexts: [{ label: "evaluation-composite.log", text: repetitive }],
  storePath
});

if (!result.ok) {
  process.stderr.write(
    `${result.error.code}: ${result.error.message}\n${JSON.stringify(
      result.error.details ?? {}
    )}\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify(
      {
        runId: result.value.package.runId,
        storePath,
        originalBytes: result.value.receipt.originalBytes,
        preparedBytes: result.value.receipt.preparedBytes,
        originalTokens: result.value.receipt.originalTokens,
        preparedTokens: result.value.receipt.preparedTokens,
        tokenReductionPercent: result.value.receipt.tokenReductionPercent,
        protectedEvidence: result.value.receipt.protectedEvidence.length,
        transformations: result.value.receipt.transformations,
        handles: result.value.receipt.handles.length,
        integrity: result.value.receipt.integrity,
        reconstruction: result.value.receipt.reconstruction
      },
      null,
      2
    )}\n`
  );
}
