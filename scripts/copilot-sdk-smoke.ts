import { resolve } from "node:path";

import {
  approveReviewSubject,
  reviewSubjectProvider
} from "../src/approval/review.js";
import { OptionalCopilotSdkAdapter } from "../src/adapters/copilot-sdk.js";
import { CommittedRunScopeAuthority } from "../src/adapters/run-authority.js";
import { canonicalJsonDigest } from "../src/core/canonical.js";
import { agentReadScopeDigest } from "../src/core/read-scope.js";
import { prepareContext } from "../src/pipeline/prepare.js";
import { builtinRuntime } from "../src/registry/builtins.js";
import {
  assessSecurity,
  authorizeExternalSend
} from "../src/security/security.js";
import { ContextStore } from "../src/storage/store.js";

if (process.env.CTXO_LIVE_COPILOT !== "1") {
  process.stdout.write(
    "Copilot SDK live smoke skipped; set CTXO_LIVE_COPILOT=1 to opt in.\n"
  );
} else {
  const storePath = resolve(
    ".context-overflow",
    `copilot-smoke-${Date.now()}.sqlite`
  );
  const prepared = await prepareContext({
    promptText:
      "Reply with exactly CONTEXT_OVERFLOW_SMOKE_OK. Do not use tools.",
    storePath
  });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const store = new ContextStore(storePath);
  const adapter = new OptionalCopilotSdkAdapter(
    undefined,
    new CommittedRunScopeAuthority(store)
  );
  try {
    const catalog = await adapter.listModels(process.cwd());
    if (!catalog.ok) throw new Error(catalog.error.message);
    const modelId =
      process.env.CTXO_COPILOT_MODEL ?? catalog.value[0]?.id;
    if (modelId === undefined) throw new Error("No Copilot model is available");
    const bytes = prepared.value.package.preparedBytes;
    const readScope = {
      runId: prepared.value.package.runId,
      evidence: [],
      sources: []
    };
    const readScopeDigest = agentReadScopeDigest(readScope);
    if (!readScopeDigest.ok) throw new Error(readScopeDigest.error.message);
    const subject = reviewSubjectProvider.provide({
      runId: prepared.value.package.runId,
      payload: bytes,
      sourceIdentities: prepared.value.package.manifest.artifacts.map(
        (artifact) => ({
          sourceId: artifact.artifactId,
          identity: {
            sha256: artifact.sha256,
            byteLength: artifact.byteLength
          }
        })
      ),
      policyDigest: canonicalJsonDigest(
        prepared.value.package.manifest.policy
      ),
      detectorRegistryDigest:
        prepared.value.package.manifest.producerRegistry?.digest ??
        builtinRuntime.registryDigest,
      reviewProducerRegistry: {
        digest: builtinRuntime.reviewRegistryDigest,
        producers: builtinRuntime.reviewProducers
      },
      readScopeDigest: readScopeDigest.value,
      evidenceDecision:
        prepared.value.package.manifest.evidenceGate?.decision ?? "ready",
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
          network: true
        }
      },
      snapshotChoice: "captured",
      payloadRole: "prepared"
    });
    if (!subject.ok) throw new Error(subject.error.message);
    const approval = approveReviewSubject({
      subject: subject.value,
      payload: bytes,
      decision: "approve-prepared"
    });
    if (!approval.ok) throw new Error(approval.error.message);
    const assessedSource = {
      sourceId: "outbound",
      bytes,
      trustClass: "external-untrusted" as const
    };
    const assessment = assessSecurity([assessedSource]);
    const authorization = authorizeExternalSend({
      payload: bytes,
      assessment,
      explicitApproval: true,
      assessedSource
    });
    if (!authorization.ok) throw new Error(authorization.error.message);
    const sent = await adapter.send({
      runId: subject.value.runId,
      approved: {
        bytes,
        subject: subject.value,
        approval: approval.value
      },
      readScope,
      security: {
        assessment,
        authorization: authorization.value,
        assessedSource
      },
      timeoutMs: 60_000
    });
    if (!sent.ok) throw new Error(sent.error.message);
    if (sent.value.responseText?.trim() !== "CONTEXT_OVERFLOW_SMOKE_OK") {
      throw new Error(
        `Unexpected Copilot smoke response: ${sent.value.responseText ?? "<missing>"}`
      );
    }
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
    store.close();
    if (!closed.ok) {
      process.stderr.write(`${closed.error.message}\n`);
      process.exitCode = 1;
    }
  }
}
