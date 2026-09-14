import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalJson } from "../src/core/canonical.js";
import { ExternalManualParityAdapter } from "../src/evaluation/manual-parity.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const root =
  option("root") ??
  process.env.CTXO_EXTERNAL_MANUAL_ROOT ??
  process.argv[2];
if (root === undefined) {
  throw new Error(
    "Pass --root <external-manual-root> or set CTXO_EXTERNAL_MANUAL_ROOT"
  );
}

const adapter = new ExternalManualParityAdapter({
  root,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
  maxDurationMs: 30_000
});
const report = await adapter.run();
if (!report.ok) throw new Error(report.error.message);

const outputDirectory = resolve(".context-overflow");
await mkdir(outputDirectory, { recursive: true });
const outputPath = resolve(
  outputDirectory,
  `external-manual-parity-${report.value.digest}.json`
);
await writeFile(
  outputPath,
  `${canonicalJson(report.value)}\n`,
  "utf8"
);

process.stdout.write(
  `${JSON.stringify(
    {
      outputPath,
      rootDigest: report.value.rootDigest,
      reportDigest: report.value.digest,
      summary: report.value.summary,
      cases: report.value.cases.map((item) => ({
        caseId: item.caseId,
        contract: item.contract,
        status: item.status,
        inputDigest: item.inputDigest,
        metrics: item.metrics,
        reasons: item.reasons
      }))
    },
    null,
    2
  )}\n`
);
