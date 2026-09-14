# Context Overflow

Context Overflow is an independent, deterministic, offline proof of concept for
reducing large coding-agent context while preserving byte-level provenance and
supporting complete reconstruction.

## Status

The TypeScript/Node.js ESM scaffold is in place. The initial CLI exposes a help
path and reserves the `prepare`, `inspect`, `retrieve`, and `verify` commands.
The reduction, durable retrieval, and fail-closed validation pipeline will be
implemented in this draft pull request.

## Architecture

```text
CLI input
  -> intake adapters
  -> immutable raw-byte artifact snapshots
  -> deterministic classification and evidence extraction
  -> segmentation and protected-range closure
  -> reduction proposals and deterministic planning
  -> transactional SQLite omission store
  -> compact rendering and output mappings
  -> fail-closed integrity and reconstruction validation
  -> tokenizer and receipt
  -> provider-neutral coding-agent handoff port
```

Domain and planning modules remain independent of filesystem, terminal,
SQLite, and provider integrations.

## Development

Requires Node.js 22.13 or newer.

```shell
npm install
npm run typecheck
npm test
npm run build
node dist/src/main.js --help
```

Licensed under Apache-2.0.
