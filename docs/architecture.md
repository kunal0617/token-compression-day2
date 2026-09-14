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
| `intake` | Raw-byte capture, canonical paths, UTF-8 and metadata | Filesystem adapter |
| `classify` | Deterministic artifact, intent, and artifact-local outcome reasons | Pure |
| `evidence` | Exact occurrence extraction and hashes | Pure |
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

Outcomes are computed per context artifact. Red wins the aggregate receipt;
green plus unknown aggregates to unknown, and green-only reduction rules apply
only to the artifact whose own authoritative outcome is green.
