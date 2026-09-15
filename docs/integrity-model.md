# Integrity model

A package is successful only after all checks below pass. Failures return a
typed non-success result; no compressed success object is emitted.

| Invariant | Validation |
|---|---|
| Artifact authority | Stored and in-memory byte lengths and full SHA-256 base64url digests match |
| Staged authority | Publication validates artifact metadata and blobs reloaded from staged SQLite rows under the write lock |
| Evidence identity | Evidence and occurrence IDs are unique; ranges and hashes match exact source bytes |
| Analysis/source separation | CI envelope normalization never changes source bytes, byte coordinates, output mappings, or reconstruction |
| Copied transcript scope | BOM mojibake and ESC-stripped SGR analysis requires a recognized timestamped CI envelope and cannot affect non-CI bracket text |
| Protected closure | Protected ranges are bounded, reference real evidence, and do not intersect transforms or omissions |
| Plan | Transforms are ordered, non-overlapping, benefit-positive, and 1:1 with omissions |
| Handles | Version, algorithm, full digest, byte length, and occurrence ID parse strictly |
| Retrieval | Every handle resolves from the staged/committed SQLite run and retrieved bytes match source |
| Compact output | Output mappings are an exact ordered partition of compact bytes |
| Source provenance | Literal and omission mappings are an exact ordered partition of every artifact |
| Literal equality | Every literal mapping equals the referenced source bytes |
| Protected occurrences | Every mandatory evidence occurrence has its own source-anchored literal mapping and digest |
| Marker integrity | Marker reason, source count, byte count, handle, output bytes, and chronology agree |
| Canonical manifest | Strict Zod schema, canonical JSON equality, and full digest agree |
| Run binding | Package, manifest, requested run, database row, and stored manifest hash identify the same run |
| Source-derived policy | Artifact classification/outcomes, intent, evidence, protected closure, and transform plan are recomputed from source bytes |
| Reconstruction | Concatenating literal bytes and retrieved omissions exactly equals every original artifact |
| Token receipt | `js-tiktoken` remeasures actual `o200k_base` original and prepared token counts |
| Publication | Run is atomically changed from staging/pending to committed/validated with its receipt |
| Receipt binding | Canonical receipt digest, requested run ID, manifest-derived fields, handles, evidence, byte counts, and token counts agree |
| Receipt migration | Historical hash backfill occurs only for schema-valid, canonical, run-matching committed receipts |

The omission store is content-addressed by full digest but occurrences remain
separate rows and handles. Identical omitted bytes can share an immutable blob
without sharing occurrence identity.

The model proves retention and reconstruction for accepted packages. It does
not claim semantic optimization, redaction, or parser completeness beyond the
tested deterministic rules.
