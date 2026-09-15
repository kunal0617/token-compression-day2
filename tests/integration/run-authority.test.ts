import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CommittedRunScopeAuthority } from "../../src/adapters/run-authority.js";
import { prepareContext } from "../../src/pipeline/prepare.js";
import { ContextStore } from "../../src/storage/store.js";
import { snapshotsFromManifest } from "../../src/validate/validate.js";
import { sha256Base64Url } from "../../src/core/hash.js";
import { canonicalJsonDigest } from "../../src/core/canonical.js";
import { agentReadScopeDigest } from "../../src/core/read-scope.js";
import {
  approveReviewSubject,
  reviewSubjectProvider
} from "../../src/approval/review.js";
import { builtinRuntime } from "../../src/registry/builtins.js";
import {
  assessSecurity,
  authorizeExternalSend
} from "../../src/security/security.js";

describe("committed run read-scope authority", () => {
  it("validates evidence and source bytes against committed snapshots", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-run-authority-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const prepared = await prepareContext({
        promptText: "Inspect the command exit.",
        contextTexts: [
          {
            label: "authority.log",
            text: "$ demo\nProcess exited with code 0\n"
          }
        ],
        storePath
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const store = new ContextStore(storePath);
      try {
        const bytes = store.loadArtifactBytes(prepared.value.package.runId);
        expect(bytes.ok).toBe(true);
        if (!bytes.ok) return;
        const snapshots = snapshotsFromManifest(
          prepared.value.package.manifest,
          bytes.value
        );
        expect(snapshots.ok).toBe(true);
        if (!snapshots.ok) return;
        const evidence = prepared.value.package.manifest.evidence[0];
        expect(evidence).toBeDefined();
        if (evidence === undefined) return;
        const artifact = snapshots.value.find(
          (item) => item.artifactId === evidence.artifactId
        );
        expect(artifact).toBeDefined();
        if (artifact === undefined) return;
        const sourceBytes = Buffer.from("export const value = 1;", "utf8");
        const source = {
          sourceId: "source",
          path: "source.ts",
          startByte: 0,
          endByte: sourceBytes.length,
          bytes: sourceBytes,
          sha256: sha256Base64Url(sourceBytes),
          unitIds: ["unit"]
        };
        const authority = new CommittedRunScopeAuthority(store, [source]);
        const scope = {
          runId: prepared.value.package.runId,
          evidence: [
            {
              span: evidence,
              bytes: artifact.bytes.subarray(
                evidence.startByte,
                evidence.endByte
              )
            }
          ],
          sources: [source]
        };
        const scopeDigest = agentReadScopeDigest(scope);
        expect(scopeDigest.ok).toBe(true);
        if (!scopeDigest.ok) return;
        const payload = prepared.value.package.preparedBytes;
        const subject = reviewSubjectProvider.provide({
          runId: scope.runId,
          payload,
          sourceIdentities:
            prepared.value.package.manifest.artifacts.map((item) => ({
              sourceId: item.artifactId,
              identity: {
                sha256: item.sha256,
                byteLength: item.byteLength
              }
            })),
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
          readScopeDigest: scopeDigest.value,
          evidenceDecision: "ready",
          tokenizer:
            prepared.value.package.manifest.tokenizer.encoding,
          target: {
            adapterId: "offline",
            modelId: "model",
            workingDirectory: process.cwd(),
            permissions: {
              sourceRead: true,
              evidenceRead: true,
              fileWrite: false,
              shell: false,
              network: false
            }
          },
          snapshotChoice: "captured",
          payloadRole: "prepared"
        });
        expect(subject.ok).toBe(true);
        if (!subject.ok) return;
        const approval = approveReviewSubject({
          subject: subject.value,
          payload,
          decision: "approve-prepared"
        });
        expect(approval.ok).toBe(true);
        if (!approval.ok) return;
        const authorityToken = authority.issueReview({
          runId: scope.runId,
          approved: {
            bytes: payload,
            subject: subject.value,
            approval: approval.value,
            evidenceFacts: []
          },
          readScope: scope
        });
        expect(authorityToken.ok).toBe(true);
        if (!authorityToken.ok) return;
        const assessedSource = {
          sourceId: "outbound",
          bytes: payload,
          trustClass: "external-untrusted" as const
        };
        const assessment = assessSecurity([assessedSource]);
        const authorization = authorizeExternalSend({
          payload,
          assessment,
          explicitApproval: true,
          assessedSource
        });
        expect(authorization.ok).toBe(true);
        if (!authorization.ok) return;
        const request = {
          runId: scope.runId,
          approved: {
            bytes: payload,
            subject: subject.value,
            approval: approval.value,
            evidenceFacts: [],
            authorityToken: authorityToken.value
          },
          readScope: scope,
          security: {
            assessment,
            authorization: authorization.value,
            assessedSource
          },
          timeoutMs: 100
        };
        expect(authority.validate(request).ok).toBe(true);
        const originalSource = {
          ...source,
          bytes: Buffer.from(sourceBytes),
          unitIds: [...source.unitIds]
        };
        source.bytes.fill(0x78);
        expect(
          authority.validate({
            ...request,
            readScope: { ...scope, sources: [originalSource] }
          }).ok
        ).toBe(true);
        const scopedEvidence = scope.evidence[0];
        expect(scopedEvidence).toBeDefined();
        if (scopedEvidence === undefined) return;
        expect(
          authority.validate({
            ...request,
            readScope: {
              ...scope,
              evidence: [
                {
                  ...scopedEvidence,
                  bytes: Buffer.from("tampered", "utf8")
                }
              ]
            }
          }).ok
        ).toBe(false);
        expect(
          authority.validate({
            ...request,
            readScope: {
              ...scope,
              sources: [
                {
                  ...source,
                  bytes: Buffer.from(sourceBytes).fill(0x78)
                }
              ]
            }
          }).ok
        ).toBe(false);
        expect(
          authority.validate({
            ...request,
            readScope: {
              ...scope,
              sources: [{ ...originalSource, path: "forged.ts" }]
            }
          }).ok
        ).toBe(false);
        expect(
          authority.validate({
            ...request,
            readScope: {
              ...scope,
              evidence: [
                {
                  ...scopedEvidence,
                  span: {
                    ...scopedEvidence.span,
                    kind: "identifier"
                  }
                }
              ],
              sources: [originalSource]
            }
          }).ok
        ).toBe(false);
        const unrelated = Buffer.from(
          "ARBITRARY CLEAN OUTBOUND PAYLOAD",
          "utf8"
        );
        const unrelatedSubject = reviewSubjectProvider.provide({
          ...subject.value,
          payload: unrelated
        });
        expect(unrelatedSubject.ok).toBe(true);
        if (!unrelatedSubject.ok) return;
        const unrelatedApproval = approveReviewSubject({
          subject: unrelatedSubject.value,
          payload: unrelated,
          decision: "approve-prepared"
        });
        expect(unrelatedApproval.ok).toBe(true);
        if (!unrelatedApproval.ok) return;
        expect(
          authority.issueReview({
            runId: scope.runId,
            approved: {
              bytes: unrelated,
              subject: unrelatedSubject.value,
              approval: unrelatedApproval.value,
              evidenceFacts: []
            },
            readScope: scope
          }).ok
        ).toBe(false);
        const currentSubject = reviewSubjectProvider.provide({
          ...subject.value,
          payload: unrelated,
          sourceIdentities: [
            {
              sourceId: "invented-current",
              identity: {
                sha256: sha256Base64Url(unrelated),
                byteLength: unrelated.length
              }
            }
          ],
          snapshotChoice: "current",
          payloadRole: "current"
        });
        expect(currentSubject.ok).toBe(true);
        if (!currentSubject.ok) return;
        const currentApproval = approveReviewSubject({
          subject: currentSubject.value,
          payload: unrelated,
          decision: "approve-selected"
        });
        expect(currentApproval.ok).toBe(true);
        if (!currentApproval.ok) return;
        expect(
          authority.issueReview({
            runId: scope.runId,
            approved: {
              bytes: unrelated,
              subject: currentSubject.value,
              approval: currentApproval.value,
              evidenceFacts: []
            },
            readScope: scope
          }).ok
        ).toBe(false);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
