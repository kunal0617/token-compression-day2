import {
  approveReviewSubject,
  reviewSubjectProvider
} from "../src/approval/review.js";
import { OptionalCopilotSdkAdapter } from "../src/adapters/copilot-sdk.js";
import { canonicalJsonDigest } from "../src/core/canonical.js";

if (process.env.CTXO_LIVE_COPILOT !== "1") {
  process.stdout.write(
    "Copilot SDK live smoke skipped; set CTXO_LIVE_COPILOT=1 to opt in.\n"
  );
} else {
  const adapter = new OptionalCopilotSdkAdapter();
  try {
    const catalog = await adapter.listModels(process.cwd());
    if (!catalog.ok) throw new Error(catalog.error.message);
    const modelId =
      process.env.CTXO_COPILOT_MODEL ?? catalog.value[0]?.id;
    if (modelId === undefined) throw new Error("No Copilot model is available");
    const bytes = Buffer.from(
      "Reply with exactly CONTEXT_OVERFLOW_SMOKE_OK. Do not use tools.",
      "utf8"
    );
    const subject = reviewSubjectProvider.provide({
      runId: `smoke-${Date.now()}`,
      payload: bytes,
      sourceIdentities: [],
      policyDigest: canonicalJsonDigest("smoke-policy"),
      detectorRegistryDigest: canonicalJsonDigest("smoke-registry"),
      tokenizer: "o200k_base",
      target: {
        adapterId: adapter.metadata.producerId,
        modelId,
        workingDirectory: process.cwd(),
        permissions: {
          sourceRead: false,
          evidenceRead: false,
          fileWrite: false,
          shell: false,
          network: false
        }
      },
      snapshotChoice: "captured"
    });
    if (!subject.ok) throw new Error(subject.error.message);
    const approval = approveReviewSubject({
      subject: subject.value,
      payload: bytes,
      decision: "approve-prepared"
    });
    if (!approval.ok) throw new Error(approval.error.message);
    const sent = await adapter.send({
      runId: subject.value.runId,
      approved: {
        bytes,
        subject: subject.value,
        approval: approval.value
      },
      readScope: {
        runId: subject.value.runId,
        evidence: [],
        sources: []
      },
      timeoutMs: 60_000
    });
    if (!sent.ok) throw new Error(sent.error.message);
    process.stdout.write(
      `${JSON.stringify(
        {
          sessionId: sent.value.sessionId,
          modelId: sent.value.modelId,
          applicationPayloadSha256: sent.value.applicationPayloadSha256,
          responseText: sent.value.responseText,
          events: sent.value.events.length
        },
        null,
        2
      )}\n`
    );
  } finally {
    const closed = await adapter.close();
    if (!closed.ok) {
      process.stderr.write(`${closed.error.message}\n`);
      process.exitCode = 1;
    }
  }
}

