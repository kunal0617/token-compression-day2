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

See [architecture](docs/architecture.md) and the
[integrity model](docs/integrity-model.md).

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
