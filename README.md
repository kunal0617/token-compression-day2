# Context Overflow

Context Overflow is an independent, deterministic, offline proof of concept
that reduces repetitive coding-agent context without discarding source bytes.
Every released package is backed by occurrence-specific evidence mappings,
durable omission handles, a canonical manifest, and byte-identical
reconstruction.

The project does not integrate with the GitHub Copilot SDK or any network/LLM
provider. Its provider-neutral handoff port accepts only a
`ValidatedContextPackage`.

## Guarantees

- Raw `Buffer` bytes are captured before decoding or normalization.
- UTF-8, BOM, LF/CRLF/CR/mixed newlines, ANSI, limits, and completeness are
  explicit.
- Evidence and duplicate occurrences have separate full collision-resistant
  identities.
- Prompt, failures, assertions, exception chains, diagnostics, commands, exit
  codes, summaries, diffs, and linked causal context are protected.
- Reduction proposals operate on immutable half-open byte ranges and are
  rejected when protected, overlapping, or larger than their marker.
- SQLite stages an entire run under WAL, `synchronous=FULL`, foreign keys, and
  a busy timeout. Public reads see only atomically committed and validated runs.
- Every omitted range has one strict full-digest handle and is read back through
  SQLite before release.
- Output mappings prove the complete source partition; each mandatory evidence
  occurrence has its own byte-identical literal mapping.
- Validation reconstructs every artifact byte-for-byte and remeasures actual
  `o200k_base` tokens before a package becomes ready.
- Outcomes are artifact-local: red wins the aggregate receipt, while an
  unrelated green artifact cannot authorize warning folding in an unknown one.
- GitHub Actions/Azure-style timestamp and ANSI envelopes are stripped only in
  the analysis view. Original bytes remain the hashing, rendering, retrieval,
  and reconstruction authority.
- The analysis view also recognizes the common copied-transcript degradation:
  literal UTF-8 BOM mojibake (`\u00ef\u00bb\u00bf`) before the first ISO
  timestamp and a coherent whole-line copied-SGR wrapper such as
  `[36;1mcommand[0m` after an ESC byte has been removed. Inferred copied ANSI
  requires a non-reset opener at the start plus a trailing `[0m` reset on a
  line already proven to have a CI timestamp envelope. Embedded numeric bracket
  values, arbitrary bracket text, and non-CI logs are untouched.
- Recognized CI wrapper groups, repeated setup metadata, echoed shell
  scaffolding, and stable envelope-only repetitions can fold behind handles.
  Failure conclusions, job/workflow/run/branch/image facts, zero-artifact
  observations, metrics, actual warnings/errors, and chronology remain
  protected.
- Validated output paths are checked against the store, WAL/SHM sidecars, and
  canonical file identity before any write. Final symlinks are rejected and
  output is created exclusively without following an existing path.
- Publication reloads artifact metadata and blobs from staged SQLite rows under
  the write lock rather than trusting caller-held snapshots.
- Receipts are canonical, hashed, run-bound, rebuilt from the manifest, and
  checked again by stored-run verification.
- Classification, evidence, segmentation, reduction, and policy are routed
  through versioned producer registries. V2 manifests persist producer IDs,
  semantic versions, full digests, and a registry digest; V1 stored runs remain
  verifiable through an explicit migration path.

See [architecture](docs/architecture.md) and the
[integrity model](docs/integrity-model.md). A source-backed
[comparison with Rohit's implementation](docs/comparison-with-rohit.md)
separates verified strengths, reproduced risks, recommendations, and
unverified possibilities.

## CLI

Requires Node.js 22.13 or newer.

```shell
npm install
npm run build

node dist\src\main.js prepare --prompt-file fixtures\composite-demo.prompt.txt --context fixtures\composite-demo.log --store .context-overflow\demo.sqlite --output .context-overflow\prepared.txt
node dist\src\main.js inspect --run <run-id> --store .context-overflow\demo.sqlite
node dist\src\main.js retrieve <ctxo-handle> --store .context-overflow\demo.sqlite
node dist\src\main.js verify --run <run-id> --store .context-overflow\demo.sqlite
```

`prepare` also supports `--prompt-text`, repeated `--context`,
`--max-artifact-bytes`, and `--nearby`. Without `--output`, the validated
prepared text is included in the JSON response. Inputs exceeding limits or
invalid UTF-8 files fail explicitly; they are never truncated.

## Reduction policies

The planner keeps first/last/protected/distinct occurrences and can fold:

- consecutive and non-consecutive exact repetition, including exact
  rolling-anchor windows verified by byte comparison;
- parser-authoritative green pass/progress/cache/download/build chatter;
- deterministic artifact/tool scoped boilerplate;
- conservative templates that vary only approved timestamps, durations,
  workers, UUIDs, progress, or memory addresses.

Red and unknown outcomes preserve warning templates. Error codes, HTTP codes,
exception types, test names, expected/actual values, source locations,
versions, configuration keys, and command arguments are never broadly masked.
All folded originals remain retrievable.

## CQ-01 exact source provenance

Approved source candidates are captured as raw bytes with a full snapshot
identity. Exact `Buffer` search enumerates every overlapping occurrence and
returns explicit `no-match`, `unique`, or `ambiguous` state. Only a unique exact
match can render a source link. Fuzzy or normalized text is never authoritative.

When requested, the local source adapter binds the snapshot to Git repository
root, commit, tree, blob, repository path, mode, and whether current worktree
bytes still equal the blob. Any candidate-byte mutation invalidates the
provenance result.

## CQ-02 typed failure parsers

Versioned Vitest/Jest and Node/V8 detectors produce immutable typed reports for
failing tests, exact expected/actual values, exception types/codes/causes,
byte-ranged stack frames, commands, exits, environment facts, and explicit
completeness. Unrecognized formats return a conservative raw-range fallback
with `recognized: false` and `completeness: unknown`; they never become an
empty success.

For CI summary logs, routine path/version/timestamp/identifier occurrences stay
in the manifest but do not automatically protect neighboring lines. Source
locations require credible file extensions or diagnostic/stack/compiler
context, preventing ISO timestamps and clocks from being misclassified as
`file:line:column`. When a wrapper log reports a failed child job but lacks that
job's detailed log, the receipt explicitly warns that root-cause evidence is
missing.

### CI regression measurement

A 520-line real GitHub Actions metrics-wrapper log was evaluated locally and
was not added to this repository. Before the CI-aware changes it produced no
reduction: 16,320 → 16,320 actual tokens, 668 mandatory evidence spans, and no
handles. The safety-reviewed final result is 16,320 → 10,486 actual tokens
(**35.75%**), 77 mandatory evidence spans, and 41 retrievable handles, with integrity verified
and byte-identical reconstruction. The failing lane/setup conclusion,
workflow/run/branch/image identifiers, zero-artifact observation, metrics,
deprecation warning, and chronology remained literal.

`fixtures/github-actions-metrics-synthetic.log` is a sanitized, invented
equivalent used by the public regression suite.

The same local log was also recreated as a common manually copied transcript
by replacing the real BOM with literal `\u00ef\u00bb\u00bf` bytes and removing
ESC bytes while leaving `[36;1m... [0m` fragments. Before this hardening it
measured 15,929 → 12,803 tokens (**19.62%**), 86 protected spans, and 27
handles. It now measures 15,929 → 11,136 tokens (**30.09%**), 87 protected
spans, and 43 handles, with the same required evidence, warning, integrity, and
byte-identical reconstruction.

## Development

```shell
npm run check
npm run test:unit
npm run test:integration
```

The tests cover byte indexing and encodings, classifier conflicts, protected
duplicates, exact and template reductions, strict handles, committed visibility,
transaction rollback, mutation failures, property-based reconstruction, and a
composite adversarial log.

## Current limitations

- The POC accepts pasted text and explicit local UTF-8 files only.
- Parser coverage is intentionally narrow and conservative; unsupported red or
  unknown diagnostics remain inline.
- `node:sqlite` avoids a native package dependency and is available in the
  supported Node runtime, but some Node releases still print an experimental
  API warning.
- Secret-like bytes are preserved and stored locally; this POC does not perform
  redaction or upload data.
- No live coding-agent provider, UI, streaming intake, or semantic/LLM adviser
  is included.

Licensed under Apache-2.0.
