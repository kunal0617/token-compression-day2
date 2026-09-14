# Architecture

## Pipeline

```text
CLI
  -> file/pasted intake
  -> immutable ArtifactSnapshot(Buffer)
  -> artifact and intent classification
  -> occurrence-specific EvidenceSpan extraction
  -> line/structural segmentation
  -> protected-range closure
  -> independent reduction proposals
  -> deterministic overlap planner
  -> single render with source/output mappings
  -> staged SQLite run and omission blobs
  -> fail-closed validation and reconstruction
  -> atomic committed+validated publication
  -> receipt and provider-neutral handoff
```

All transformation coordinates use inclusive `startByte` and exclusive
`endByte`. Decoded text is used only for deterministic recognition and display;
hashes, slicing, mappings, retrieval, and reconstruction use original bytes.

## Boundaries

| Area | Responsibility | Dependency boundary |
|---|---|---|
| `contracts` | Serializable domain contracts and Zod schemas | No filesystem or SQLite |
| `registry` | Versioned feature/detector/policy/adaptor registries and deterministic registry digest | Pure |
| `intake` | Raw-byte capture, canonical paths, UTF-8 and metadata | Filesystem adapter |
| `classify` | Deterministic artifact, intent, and artifact-local outcome reasons | Pure |
| `evidence` | Exact occurrence extraction and hashes | Pure |
| `ci` | Analysis-only timestamp/ANSI envelopes, CI criticality, and missing-evidence detection | Pure |
| `provenance` | CQ-01 approved-candidate exact occurrence enumeration and optional Git object identity | Pure matcher + explicit local adapter |
| `segment` / `protect` | Structural lines and protected closure | Pure |
| `reduce` | Proposals, benefit checks, and overlap resolution | Pure |
| `render` | One compact render and mapping creation | Pure |
| `storage` | SQLite schema, staging, publication, strict retrieval | SQLite adapter |
| `validate` | Manifest, mappings, readback, partition, reconstruction | Reads storage port |
| `token` / `receipt` | Actual tokenizer and release evidence | Tokenizer adapter |
| `ports` | Validated coding-agent handoff contract | Provider neutral |
| `cli` (`main.ts`) | Argument, filesystem output, and terminal adapter | Boundary only |

## Transaction lifecycle

1. `stageRun` writes the run, artifact blobs, omission blobs, evidence,
   mappings, and canonical manifest in one `BEGIN IMMEDIATE` transaction.
2. The durable row remains `staging/pending`. Public manifest, receipt, compact
   output, and handle APIs cannot read it.
3. Store-owned `publishValidated` acquires a SQLite write lock and runs the
   validator. It reloads authoritative artifact rows/blobs from SQLite and uses
   run-scoped staging reads for the manifest, compact output, and every
   omission handle while competing writes remain blocked.
4. A private finalizer writes the receipt, changes the run to
   `committed/validated`, and commits the held transaction. Callers cannot
   publish without executing validation.
5. Stored-run verification reloads the canonical, hashed, run-bound receipt and
   rebuilds its source-derived fields from the committed manifest.

When an older database first receives the `receipt_hash` column, only receipts
that pass schema, canonical-form, and run-ID checks are backfilled. Corrupt
historical receipts fail explicitly.
5. Any validation failure changes only that staging run to `failed`. A staging
   crash remains invisible to public reads.

## Determinism

Classifiers, extractors, segments, protected closure, proposals, overlap
ranking, markers, and mappings are source-derived. A run UUID and creation time
identify an execution, so canonical manifests from separate executions are not
expected to have the same digest even when the deterministic plan is equal.

## Versioned producers

Feature providers, detectors, policy rules, source adapters, code-structure
providers, semantic-edge providers, coding-agent adapters, helper-model
adapters, and evaluation adapters share immutable producer metadata:
`producerId`, kind, semantic version, and a full digest of the declared
contract/rule set. Detectors emit findings only; the deterministic policy layer
turns reduction findings into a final non-overlapping plan.

New runs use manifest format v2 and persist the complete sorted producer set in
both the canonical manifest and `run_producers`. Validation recomputes the
built-in registry digest and checks the staged/committed rows. Legacy v1 runs
contain no producer registry and remain supported without fabricating metadata.

Outcomes are computed per context artifact. Red wins the aggregate receipt;
green plus unknown aggregates to unknown, and green-only reduction rules apply
only to the artifact whose own authoritative outcome is green.

Recognized CI logs receive a separate analysis view. A leading BOM/ISO
timestamp and ANSI SGR wrappers are excluded from signatures and parser
matching only; source byte coordinates and all retained/omitted bytes are
unchanged. The timestamp-proven path also recognizes BOM mojibake and coherent
whole-line copied-SGR wrappers with an opening numeric code and trailing reset
left after an ESC byte is removed; embedded numeric bracket values remain
literal. That recognition is never applied globally. CI group proposals keep directive titles and critical lines literal
while placing only explicitly allowlisted runner/setup/JSON/shell wrapper
records behind ordinary content-addressed handles. CI mode requires at least
three envelopes, at least 40% envelope coverage, and balanced directive
evidence; a few timestamped lines cannot opt an arbitrary log into CI folding.
