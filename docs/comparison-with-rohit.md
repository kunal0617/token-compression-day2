# Comparison with Rohit's context-overflow implementation

## Scope

This comparison inspected authenticated private repository
`rohitV-MSFT/token-compression-for-longer-prompts` at current `main` commit
[`9d8833a9bff8f7010c8ff513553f998359e19519`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/commit/9d8833a9bff8f7010c8ff513553f998359e19519)
from 2026-09-14. The implementation was traced through GitHub API/archive reads;
no code was copied into this project and the target test suite was not run.

The two projects have different goals. Rohit's repository is a broader context
quality and preflight system with conservative evidence capture and advice.
This POC concentrates on transactional, occurrence-specific reduction,
retrieval, and reconstruction.

## Strengths verified in Rohit's implementation

- **Raw-byte capture and exact text handling.** Approved files are read as
  bytes; strict UTF-8 parsing records BOM/newline details and byte offsets, and
  bounded line reads map to captured content.
  [`local-artifact-input.ts:8-12,56-63`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/adapters/filesystem/local-artifact-input.ts#L8-L63)
  [`parsing.ts:88-162`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/domain/evidence/parsing.ts#L88-L162)
- **Content-addressed evidence.** Raw objects are SHA-256 named and verified on
  write and read; corrupt objects are rejected rather than replaced from the
  live source.
  [`local-evidence-store.ts:84-131`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/adapters/evidence-store/local-evidence-store.ts#L84-L131)
- **Scoped exact reads.** Reads can be constrained to an approved case and
  bounded range, revalidate the object, and return a hash for the selected
  bytes.
  [`evidence-read-service.ts:33-47,71-126`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/application/evidence/evidence-read-service.ts#L33-L126)
- **Completeness and secret signals.** Completeness is explicit, including
  unknown terminal state. A local scanner reports redacted, high-confidence
  secret-like findings and correctly avoids claiming exhaustive detection.
  [`capture-service.ts:308-338`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/application/evidence/capture-service.ts#L308-L338)
  [`secret-scan.ts:4-12,51-71`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/domain/evidence/secret-scan.ts#L4-L71)
- **Mandatory-inline gating.** Preflight validation occurs before the approved
  payload is sent and fails closed when validation is unavailable or fails.
  [`preflight-service.ts:280-324`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/application/preflight/preflight-service.ts#L280-L324)
- **Exact repetition and restoration.** CQ-04 verifies omitted reads, restores
  separators, and requires final text, byte length, and SHA-256 to equal the
  original.
  [`cq-04-safe-repetition-assembly.ts:334-419`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/application/preflight/cq-04-safe-repetition-assembly.ts#L334-L419)
  [`cq-04-safe-repetition.integration.test.ts:90-138`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/tests/integration/cq-04-safe-repetition.integration.test.ts#L90-L138)
- **Context-quality signals.** Composition covers source-aware paste,
  incomplete evidence, distinct diagnostics, repetition, task-focused large
  artifacts, missing facts, and freshness mismatches.
  [`context-overflow-composition.ts:207-215,257-264`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/application/context-overflow-composition.ts#L207-L264)
- **Conservative model-fit advice.** Recommendations require host-reported
  availability and curated capability eligibility; the empty default invents
  no model capabilities.
  [`context-overflow-composition.ts:139-152,217-246`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/application/context-overflow-composition.ts#L139-L246)

## Verified facts and reproduced risks

### Mandatory evidence is not occurrence-assigned

The validator re-reads each referenced source range and verifies its range
hash. For mandatory-inline output, it ultimately checks whether the prepared
payload contains the evidence text. It does not assign separate output offsets
or consume occurrences.
[`mandatory-evidence.ts:18-58`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/application/evidence/mandatory-evidence.ts#L18-L58)

The focused tests cover present, absent, hash-mismatch, and wrong-case reads,
but not two identical mandatory spans requiring two output occurrences.
[`mandatory-evidence.test.ts:62-100`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/tests/unit/mandatory-evidence.test.ts#L62-L100)

A focused predicate reproduction used one `alpha\nbeta` output occurrence and
two identical obligations. Both `includes` checks passed while the actual
occurrence count was one. This demonstrates an ambiguity if multiplicity is
intended; it is not a defect if the contract deliberately means only “this text
survives somewhere.”

**POC difference:** every mandatory `EvidenceSpan` has a distinct occurrence
ID and a source-anchored `EvidenceOutputMapping`; duplicate bytes at different
positions cannot satisfy each other.

### CQ-04 restoration needs the full plan

The CQ-04 plan contains original/reduced payloads, original hash and length,
omitted blocks/runs, separators, and mandatory evidence.
[`cq-04-safe-repetition-assembly.ts:54-95`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/application/preflight/cq-04-safe-repetition-assembly.ts#L54-L95)

Its marker carries line/group/sequence data but no durable plan, case, artifact,
or range-hash handle.
[`cq-04-safe-repetition-assembly.ts:635-667`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/application/preflight/cq-04-safe-repetition-assembly.ts#L635-L667)
Restoration accepts the complete in-memory plan and compares the result with
the plan's original content, length, and hash.
[`cq-04-safe-repetition-assembly.ts:334-413,433-543`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/application/preflight/cq-04-safe-repetition-assembly.ts#L334-L543)

**Qualification:** omitted blocks do have precise evidence references and an
external caller could serialize the plan. The repository itself does not
provide a durable plan store or standalone marker handle.

**POC difference:** every marker contains a strict
`ctxo:v1:sha256:<full-digest>:<size>:<occurrence-id>` handle that resolves
independently through SQLite.

### Storage operations are individually atomic, not run-transactional

The evidence store writes UUID-suffixed temporary files and renames them,
providing individual same-filesystem atomic replacement.
[`local-evidence-store.ts:397-423`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/adapters/evidence-store/local-evidence-store.ts#L397-L423)
An artifact still requires sequential object, manifest, and index operations,
and active-case state is another independent read-modify-write.
[`local-evidence-store.ts:55-100,143-160`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/adapters/evidence-store/local-evidence-store.ts#L55-L160)
The CLI captures multiple paths one at a time, so later failure does not roll
back earlier captures.
[`main.ts:524-542`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/main.ts#L524-L542)

There is no run-level staging journal, transaction, commit marker, or rollback.
Atomic rename power-loss durability was not established because file and
directory `fsync` behavior was not tested.

**POC difference:** all rows/blobs/mappings/manifests stage in one SQLite
transaction, remain publicly invisible, validate under a held write lock, and
publish with the receipt in one status transition.

### Some bookkeeping read failures become absence or empty state

Index read/parse failures return `undefined`, later surfaced as artifact-not
found.
[`local-evidence-store.ts:202-218,264-277`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/adapters/evidence-store/local-evidence-store.ts#L202-L277)
Any active-case read/parse error returns an empty set, and directory enumeration
errors become empty lists.
[`local-evidence-store.ts:315-322,435-452`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/adapters/evidence-store/local-evidence-store.ts#L315-L452)
This can turn corruption or an operational failure into apparent absence and
can affect retention decisions.
[`retention.ts:11-22`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/domain/evidence/retention.ts#L11-L22)

Manifest syntax corruption is stricter: it becomes `SNAPSHOT_CORRUPTED` and is
covered by a focused test.
[`local-evidence-store.ts:245-261`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/adapters/evidence-store/local-evidence-store.ts#L245-L261)
[`local-evidence-store.test.ts:165-185`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/tests/unit/local-evidence-store.test.ts#L165-L185)

**POC difference:** only an actual missing committed row is absence; parse,
schema, digest, permission, and SQLite failures are typed non-success results.

### Manifest metadata is not comprehensively runtime-integrity protected

`EvidenceManifest` is a detailed TypeScript interface and includes an original
content hash, but no canonical manifest, case-root, or run-commit hash.
[`evidence.ts:69-92`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/domain/contracts/evidence.ts#L69-L92)
Read code casts parsed JSON to `EvidenceManifest`; it does not comprehensively
validate fields or `schemaVersion`.
[`local-evidence-store.ts:245-261`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/adapters/evidence-store/local-evidence-store.ts#L245-L261)
Artifact identity binds source and raw content, but not all completeness,
retention, token, and secret metadata.
[`capture-service.ts:138-208`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/application/evidence/capture-service.ts#L138-L208)

**POC difference:** manifests and receipts use strict Zod schemas, canonical
JSON equality, and full SHA-256 base64url digests.

### CQ-04 is deliberately exact rather than outcome/template-aware

Repetition groups use byte hash and length and additionally require consistent
distinguishing facts, parser eligibility, and no mandatory occurrence.
[`cq-04-safe-repetition.ts:506-592`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/domain/signals/context/cq-04-safe-repetition.ts#L506-L592)
The live parser recognizes a narrow set of retry, failure, completion, test
boilerplate, stack, and warning records.
[`context-overflow-live-adapters.ts:587-695`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/application/context-overflow-live-adapters.ts#L587-L695)
No normalization groups different volatile values, and tests preserve
same-shaped frames with changed line numbers.
[`cq-04-recursion-trace.test.ts:122-134`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/tests/unit/cq-04-recursion-trace.test.ts#L122-L134)

This is a safety strength, not a defect. It also means the current implementation
does not cover broader parser-authoritative success folding or conservative
timestamp/duration/worker/UUID/progress/address templates.

**POC difference:** exact folding remains the highest-priority baseline; green
success and tightly approved templates are lower-priority, benefit-gated, fully
retrievable, and prohibited from masking root-cause fields.

### No universal source-partition certificate spans every transformation

The shared proposal contract contains a proposed payload, explanation, and
optional mandatory evidence, but no source partition, output-span map,
generated-text classification, or transformation certificate.
[`preflight.ts:52-61`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/domain/contracts/preflight.ts#L52-L61)
The policy engine resolves proposals and forwards the selected payload without
a generic source-to-output coverage proof.
[`policy-engine.ts:31-113`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/domain/policy/policy-engine.ts#L31-L113)

**Qualification:** CQ-04 has strong detector-specific range validation and
exact restoration. The finding is about the common framework, not a claim that
individual detectors lose provenance.

**POC difference:** literal, omission, evidence, and synthetic mappings are
deterministically re-rendered and prove every artifact's complete source
partition before release.

### Exact token measurement is injectable; the default CLI is estimated

Token results are correctly labelled `model-tokenizer` or `estimated`, with a
fallback of `ceil(characters / 4)`.
[`token-estimate.ts:1-24`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/domain/evidence/token-estimate.ts#L1-L24)
`CompositeTokenCounter` accepts an injected tokenizer and otherwise falls back;
the project comments state that it does not ship a tokenizer library.
[`composite-token-counter.ts:5-27`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/adapters/tokenizer/composite-token-counter.ts#L5-L27)
The normal CLI capture path does not inject one.
[`main.ts:524-531`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/main.ts#L524-L531)
[`capture-service.ts:138-151`](https://github.com/rohitV-MSFT/token-compression-for-longer-prompts/blob/9d8833a9bff8f7010c8ff513553f998359e19519/src/application/evidence/capture-service.ts#L138-L151)

**POC difference:** `js-tiktoken` performs actual `o200k_base` measurement and
the validator repeats that measurement before acceptance.

## Recommendations for Rohit's design

1. Assign mandatory spans distinct monotonic output offsets, or explicitly
   define multiplicity as out of scope.
2. Persist a versioned, hashed CQ-04 plan and place an opaque plan/run handle in
   markers.
3. Stage a complete capture run and publish one commit record after all
   objects, manifests, indexes, and active-case updates succeed.
4. Treat only expected not-found conditions as absence; surface parse,
   permission, and I/O failures explicitly.
5. Runtime-validate manifests and add canonical manifest/case/run integrity
   hashes.
6. Keep exact CQ-04 as the safe baseline. Any outcome/template folding should
   require parser-defined invariants and prohibit masking distinct diagnostics.
7. Add a common transformation certificate covering source partitions and
   generated annotations.
8. Inject a model tokenizer for hard limits while preserving the existing
   measurement-method labels.

## Unverified possibilities and limits

- External code outside the inspected repository could serialize CQ-04 plans
  or inject a model tokenizer.
- Atomic rename and power-loss durability were not reproduced.
- The complete source scan supports the absence of a common mapping proof but
  cannot exclude differently named downstream validation outside the
  repository.
- Secret scanning is intentionally non-exhaustive and is not proof that stored
  content contains no credentials.
- The target test suite was inspected but not executed.

