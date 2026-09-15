# Comparative benchmark workflow

The benchmark workflow keeps private fixture and response content under the
ignored `.context-overflow/` directory. Suite and shareable report metadata use
relative paths and digests; they never contain the external fixture root.

## 1. Export a suite

```shell
node dist\src\main.js benchmark export \
  --root <external-manual-root> \
  --output .context-overflow\benchmark-suite
```

Use `--cases cq02,cq03-incomplete,cq04` to export a subset. Supported case IDs
are:

`cq01`, `cq02`, `cq03-incomplete`, `cq03-complete`, `cq04`, `cq05`,
`cq06-missing`, `cq06-observed`, `cq07`, `mf01`, `mf02`, `mf03`, and `luna`.

Each case directory contains:

- `original.bin` and `prepared.bin`, generated through the production
  preparation pipeline;
- the transactional SQLite run used to validate and reconstruct the pair;
- a hashed receipt; and
- a local rubric containing required facts and deterministic advice.

Export refuses paths outside `.context-overflow`, existing destinations,
symlink escapes, unknown cases, invalid UTF-8, and configured byte/time limits.

## 2. Review the call plan

```shell
node dist\src\main.js benchmark live \
  --suite .context-overflow\benchmark-suite \
  --models claude-opus-5,gpt-5.4-mini \
  --trials 3 \
  --output .context-overflow\benchmark-run \
  --dry-run
```

The command writes and prints the canonical replay manifest. It binds the
suite/source/payload/model/settings/permissions/adapter/executable/protocol
digests, counterbalanced trial order, case list, and estimated call count.
The default full two-model, three-trial plan has 102 live calls. It is not
launched automatically.

## 3. Run approved live trials

Live execution requires both gates:

```powershell
$env:CTXO_LIVE_EVALUATION = "1"
node dist\src\main.js benchmark live `
  --suite .context-overflow\benchmark-suite `
  --models claude-opus-5,gpt-5.4-mini `
  --trials 3 `
  --output .context-overflow\benchmark-run `
  --live
```

The terminal displays the canonical manifest and requires its exact digest.
For noninteractive automation, first review the dry-run manifest and pass the
same digest with `--approve-manifest <digest>`.

Every live trial uses a fresh empty-mode Copilot session and an exact pinned
model. Permissions default to evidence/source/network only; shell and write are
disabled. The runner rehashes payloads before each trial, scans outbound and
response bytes, aborts on timeout, and persists terminal trial state before
continuing. Resume skips completed, failed, timed-out, blocked, and interrupted
trials, preventing duplicate model calls.

`cq03-incomplete` and `cq06-missing` are scored as deterministic correct
abstentions without model calls. `cq03-complete` and `cq06-observed` run live.
MF cases use three unchanged-task trials per model and retain their separate
deterministic advice. The Luna helper is optional through `--helper-model`; when
omitted it is recorded as not applicable.

## 4. Generate content-safe reports

```shell
node dist\src\main.js benchmark report \
  --run <benchmark-run-id> \
  --format markdown
```

Formats are `json`, `markdown`, and `csv`. Reports are generated per model and
include A/A self agreement, A/B paired metrics, evidence/failure/citation
recall, abstention, unsupported claims, contradictions, retrieval and phase
latency, input/output token counts, decisions/tools/permissions, seeded
confidence intervals, effect-size warnings, and reporting floors.

The shareable report contains no prompts or responses. It links only to the
relative ignored run directory. Detailed responses remain local and are
digest-checked before reporting.
