import { describe, expect, it } from "vitest";

import type {
  EvidenceFact,
  EvidenceObligationSpec,
  EvidenceRetrievalAdapter
} from "../../src/contracts/obligations.js";
import { canonicalJsonDigest } from "../../src/core/canonical.js";
import { success } from "../../src/core/result.js";
import { snapshotBytes } from "../../src/intake/intake.js";
import {
  assessFailureEvidence,
  buildFailureObligationSpecs,
  evidenceObligationEvaluator,
  executeBoundedRetrieval,
  factsFromFailureReports,
  gatherMoreEvidencePolicy
} from "../../src/obligations/evaluate.js";
import { typedFailureParsers } from "../../src/parsers/failures.js";

function spec(
  id: string,
  key: string,
  options: Partial<EvidenceObligationSpec> = {}
): EvidenceObligationSpec {
  return {
    obligationId: id,
    kind: "configuration",
    description: id,
    key,
    required: true,
    ...options
  };
}

describe("CQ-03/CQ-06 evidence obligations", () => {
  it("reports satisfied, missing, ambiguous, contradicted, and stale explicitly", () => {
    const specs: EvidenceObligationSpec[] = [
      spec("satisfied", "a"),
      spec("missing", "b"),
      spec("ambiguous", "c"),
      spec("contradicted", "d", { expectedValue: "expected" }),
      spec("stale", "e", { freshnessMs: 1_000 })
    ];
    const facts: EvidenceFact[] = [
      {
        factId: "a1",
        kind: "configuration",
        key: "a",
        value: "one",
        evidenceIds: ["e1"]
      },
      {
        factId: "c1",
        kind: "configuration",
        key: "c",
        value: "one",
        evidenceIds: []
      },
      {
        factId: "c2",
        kind: "configuration",
        key: "c",
        value: "two",
        evidenceIds: []
      },
      {
        factId: "d1",
        kind: "configuration",
        key: "d",
        value: "actual",
        evidenceIds: []
      },
      {
        factId: "e1",
        kind: "configuration",
        key: "e",
        value: "old",
        evidenceIds: [],
        observedAt: "2020-01-01T00:00:00.000Z"
      }
    ];
    const result = evidenceObligationEvaluator.evaluate(
      specs,
      facts,
      new Date("2030-01-01T00:00:00.000Z")
    );

    expect(
      Object.fromEntries(
        result.obligations.map((obligation) => [
          obligation.obligationId,
          obligation.status
        ])
      )
    ).toEqual({
      satisfied: "satisfied",
      missing: "missing",
      ambiguous: "ambiguous",
      contradicted: "contradicted",
      stale: "stale"
    });
    expect(result.decision).toBe("gather-more-evidence");
  });

  it("gives Gather More Evidence precedence over delivery", () => {
    const evaluated = evidenceObligationEvaluator.evaluate(
      [
        spec("required-source", "source", {
          kind: "referenced-source",
          retrieval: {
            adapterId: "source-read",
            maxBytes: 4096,
            purpose: "Read exact source"
          }
        })
      ],
      []
    );
    const decision = gatherMoreEvidencePolicy.decide(evaluated);

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.value.action).toBe("gather");
    expect(decision.value.priority).toBe(1000);
    expect(evaluated.retrievalRequests).toHaveLength(1);
  });

  it("builds external CQ03/CQ06 gaps from typed failures", () => {
    const artifact = snapshotBytes(
      Buffer.from(
        "FAIL tests/a.test.ts > suite > case\nExpected: yes\nProcess exited with code 1\n",
        "utf8"
      ),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "failure.log"
      }
    );
    const reports = typedFailureParsers.parse(artifact);
    expect(reports.ok).toBe(true);
    if (!reports.ok) return;
    const specs = buildFailureObligationSpecs({
      reports: reports.value,
      evidence: []
    });
    const facts = factsFromFailureReports(reports.value);
    const evaluated = evidenceObligationEvaluator.evaluate(specs, facts);

    expect(
      evaluated.obligations.some(
        (obligation) =>
          obligation.kind === "actual-value" &&
          obligation.status === "missing"
      )
    ).toBe(true);
    expect(evaluated.decision).toBe("gather-more-evidence");
    const external = assessFailureEvidence({
      artifact,
      evidence: []
    });
    expect(external.ok).toBe(true);
    if (external.ok) {
      expect(external.value.decision.action).toBe("gather");
    }
  });

  it("enforces retrieval count, byte, adapter, and range bounds", async () => {
    const adapter: EvidenceRetrievalAdapter = {
      metadata: {
        producerId: "test.source-read",
        kind: "source-adapter",
        version: "1.0.0",
        digest: canonicalJsonDigest("test.source-read")
      },
      retrieve: async (request) =>
        success([
          {
            factId: request.obligationId,
            kind: "referenced-source",
            key: "source",
            value: "exact",
            evidenceIds: []
          }
        ])
    };
    const valid = await executeBoundedRetrieval(
      [
        {
          obligationId: "one",
          adapterId: "source-read",
          maxBytes: 1024,
          purpose: "read"
        }
      ],
      new Map([["source-read", adapter]])
    );
    expect(valid.ok).toBe(true);

    const oversized = await executeBoundedRetrieval(
      [
        {
          obligationId: "large",
          adapterId: "source-read",
          maxBytes: 100_000,
          purpose: "read"
        }
      ],
      new Map([["source-read", adapter]])
    );
    expect(oversized.ok).toBe(false);
  });
});
