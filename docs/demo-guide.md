# Day0-5 demo guide

## Offline integrated demo

```shell
npm run demo:day0-5
```

The command creates an ignored SQLite store and JSON bundle under
`.context-overflow/`. It demonstrates:

1. raw-byte intake, classification, evidence, reduction, actual tokens, and
   committed verification;
2. typed failure reports and explicit evidence obligations;
3. CQ-01 exact provenance and a source link;
4. CQ-05 Tree-sitter/TypeScript delivery scope;
5. MF model advice;
6. terminal-controller approval and approval digest;
7. local security assessment and disabled content telemetry;
8. provider-neutral offline handoff;
9. a three-trial neutral replay manifest labeled as synthetic wiring only.

The offline demo does not fabricate model observations or comparative
statistics. Live paired evaluation requires separately recorded executions.

The demo is deterministic apart from run IDs, timestamps, and approval IDs.
All source and omission integrity checks still execute.

## Terminal review

Prepare a run, then:

```shell
node dist\\src\\main.js review --run <run-id> --store <store-path>
```

Use `diff`, `evidence`, `gaps`, `conflicts`, `security`, `model`,
`omissions`, and `retrieve <handle>` to inspect. `approve`, `original`,
`approve-merged`, `gather`, `snapshot`, `edit`, `target`, `reject`, and
`cancel` drive review. `gather` executes only configured bounded retrieval
adapters; raw fact JSON is not authoritative. Approval fails while evidence
obligations remain open and requires an opaque committed-run authority.

## Live Copilot smoke

```shell
$env:CTXO_LIVE_COPILOT = "1"
npm run smoke:copilot
```

This sends only the synthetic smoke prompt through an approval- and
security-authorized empty-mode session. It does not use repository artifacts.

## Recorded fallback

`fixtures/demo/recorded-fallback.json` describes the sanitized offline fallback
when live execution is unavailable or not explicitly enabled.
