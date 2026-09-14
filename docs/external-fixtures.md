# External fixture and contract adapters

Private or third-party fixtures must remain outside this repository.

`ExternalLocalFixtureAdapter` receives an explicitly configured external root,
loads a JSON case manifest, resolves every artifact with `realpath`, and rejects
paths that escape the root. It never copies fixture contents into the project.

For the known manual-live CQ/MF/Luna layout, use:

```shell
npm run parity:external -- --root <external-manual-root>
```

`ExternalManualParityAdapter` performs direct reads only. It does not launch a
subprocess, use the network, or inherit an external command environment. The
adapter enforces realpath-root confinement plus per-file, aggregate-byte, and
duration limits. Its ignored local report contains only case IDs, contract
status, metrics, reasons, and digests; fixture contents and external paths are
not included.

`ExternalJsonContractAdapter` runs a configured executable with:

- working directory fixed to the external root;
- one JSON `{ plan, testCase }` request on stdin;
- one `EvaluationObservation` JSON response on stdout;
- nonzero exit, process failure, or malformed JSON returned as typed failure.

Factory helpers provide stable adapter identities for:

- Rohit CQ-01 through CQ-07;
- Rohit MF-01 through MF-03;
- Luna-style contracts.

The arbitrary JSON command adapters remain disabled without explicit dangerous
opt-in. The read-only manual adapter and protocol bridges do not import or
vendor external implementation code or fixtures. Luna prompt pass-through
integrity can be measured locally, but live Luna execution is reported as
not-applicable unless an independently approved live runner is supplied.

The public neutral suite lives under `fixtures/evaluation/` and uses invented
values.
