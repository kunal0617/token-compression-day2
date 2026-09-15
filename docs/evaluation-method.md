# Evaluation method

## Design

Evaluation is replay-first and live runs are opt-in. A versioned manifest binds
the suite, cases, seed, settings, permissions, adapter, trial count, and
original/prepared/truncation arms. Every artifact path is paired with its exact
byte length and SHA-256. Every plan also binds the expected evaluator executable
and protocol digests.

The default paired design is:

- A1/A2/A3: original context.
- B1/B2/B3: prepared context.
- Optional C1/C2/C3: matched truncation baseline.

Each A/B trial pair has the same model, reasoning/context settings, permission
digest, adapter, and session-constraint digest. Observations that violate those
constraints fail rather than entering the report.
Artifacts are re-read and rehashed immediately before each trial. Explicit
external command adapters rehash their executable immediately before launch;
the default external-manual adapter launches no process and performs
root-confined direct reads only.

## Measures

- Task success.
- Visible and recoverable evidence recall.
- Distinct failure recall.
- Citation recall.
- Unsupported claims and contradictions.
- Correct abstention.
- Retrieval tokens, calls, and latency.
- Preparation, review, handoff, and model latency.
- Decisions, tools, and permissions.

Reports include per-trial scores, original/prepared means, paired difference,
Cohen-style `dz`, seeded bootstrap 95% bounds, binary success discordance, and
optional A/A noise. Reporting floors default to at least three cases and three
trials per arm.

## Outputs

The harness emits canonical JSON, Markdown, CSV, and a versioned replay
manifest. The seed makes bootstrap results deterministic.

Live execution is rejected unless `liveOptIn` is true. This prevents an
evaluation definition from silently issuing model calls.

The manual CQ/MF/Luna comparison is separate from live paired model scoring:

```shell
npm run parity:external -- --root <external-manual-root>
```

Its ignored local report contains case IDs, pass/fail/not-applicable status,
metrics, reasons, and digests only. Private fixture content is never copied or
reported.

The production comparative workflow is documented in
[`benchmark-testing.md`](benchmark-testing.md). It exports local original and
prepared payload pairs, creates a canonical approval-bound call plan, executes
fresh-session model trials with resumable terminal state, and emits content-safe
per-model JSON/Markdown/CSV reports.

Benchmark runtime identity includes the actual installed SDK entries, effective
runtime wrapper and native module (including `COPILOT_CLI_PATH` overrides), and
protocol implementation. Provider token usage is reported only when emitted by
the SDK; otherwise it remains explicitly unavailable.
