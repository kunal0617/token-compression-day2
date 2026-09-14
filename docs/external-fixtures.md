# External fixture and contract adapters

Private or third-party fixtures must remain outside this repository.

`ExternalLocalFixtureAdapter` receives an explicitly configured external root,
loads a JSON case manifest, resolves every artifact with `realpath`, and rejects
paths that escape the root. It never copies fixture contents into the project.

`ExternalJsonContractAdapter` runs a configured executable with:

- working directory fixed to the external root;
- one JSON `{ plan, testCase }` request on stdin;
- one `EvaluationObservation` JSON response on stdout;
- nonzero exit, process failure, or malformed JSON returned as typed failure.

Factory helpers provide stable adapter identities for:

- Rohit CQ-01 through CQ-07;
- Rohit MF-01 through MF-03;
- Luna-style contracts.

These adapters are protocol bridges only. They do not import, vendor, or
reinterpret external implementation code or fixtures.

The public neutral suite lives under `fixtures/evaluation/` and uses invented
values.

