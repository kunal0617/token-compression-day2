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
| `classify` | Deterministic artifact, intent, and outcome reasons | Pure |
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
3. Validation uses run-scoped staging reads, including every omission through
   its real SQLite handle path.
4. `finalizeValidated` atomically writes the receipt and changes the run to
   `committed/validated`.
5. Any validation failure changes only that staging run to `failed`. A staging
   crash remains invisible to public reads.

## Determinism

Classifiers, extractors, segments, protected closure, proposals, overlap
ranking, markers, and mappings are source-derived. A run UUID and creation time
identify an execution, so canonical manifests from separate executions are not
expected to have the same digest even when the deterministic plan is equal.

