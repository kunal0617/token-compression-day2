# Evaluation method

## Design

Evaluation is replay-first and live runs are opt-in. A versioned manifest binds
the suite, cases, seed, settings, permissions, adapter, trial count, and
original/prepared/truncation arms.

The default paired design is:

- A1/A2/A3: original context.
- B1/B2/B3: prepared context.
- Optional C1/C2/C3: matched truncation baseline.

Each A/B trial pair has the same model, reasoning/context settings, permission
digest, adapter, and session-constraint digest. Observations that violate those
constraints fail rather than entering the report.

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

