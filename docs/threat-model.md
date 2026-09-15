# Threat model

## Assets

- Original artifact and source bytes.
- Protected evidence occurrences and source provenance.
- SQLite blobs, manifests, mappings, receipts, review subjects, and approvals.
- Approved application payload bytes.
- Session/model/working-directory/permission target.
- Secret-like values and untrusted instruction-like artifact content.

## Trust classes

| Class | Examples | Default treatment |
|---|---|---|
| `user-instruction` | Explicit task prompt | Mandatory and reviewed |
| `repository-source` | Approved source files | Exact bytes and provenance |
| `build-output` | Logs, diagnostics, test output | Untrusted data; injection scanned |
| `external-untrusted` | Downloaded or third-party text | Untrusted data; injection scanned |
| `generated` | Compact markers and derived views | Deterministically reproducible |

## Controls

- High-confidence local-only scanning covers GitHub/OpenAI/AWS credentials,
  private-key headers, JWT-shaped values, and instruction-like injection
  phrases in untrusted artifacts. Findings store byte ranges and redacted
  previews, never the secret value.
- External live send is blocked by default. A separately hashed authorization
  must bind the exact payload and security assessment. The Copilot adapter also
  requires network permission in the approval envelope and conservatively
  assesses the exact outbound bytes as external-untrusted; callers cannot
  downgrade that classification.
- Blocking secret findings require a separately hashed source-linked redacted
  view. Placeholders are random or keyed HMAC; unsalted hashes of low-entropy
  secrets are prohibited.
- Indirect prompt injection is not automatically redacted or approved. It must
  be removed or explicitly resolved by a higher-level review.
- The optional Copilot SDK runs in empty mode with only run-scoped
  `evidence_read` and `source_read`. Cross-run and unapproved ranges fail.
  Tool results are rescanned before model exposure. Write, shell, and network
  permission are separate.
- A committed-run authority reloads the run and binds payload role/bytes,
  source identities, policy/detector/tokenizer metadata, exact review producer
  set, read scope, and completed evidence obligations. It issues an opaque
  random capability persisted in SQLite; self-calculated approval hashes alone
  cannot authorize a send.
- Bounded retrieval results require a persisted opaque execution receipt that
  binds request, response, adapter, and returned-fact digests. Copying trusted
  adapter metadata and recomputing public hashes is insufficient.
- Live SDK authority is limited to committed prepared/captured bytes. Locally
  reviewed current/both/merged payloads cannot cross the SDK boundary without a
  future trusted capture/merge attestation.
- SDK operations are serialized so cached-session sends, event subscriptions,
  and permission/scope reconfiguration cannot overlap.
- Hosted evidence helpers must attest the enforced empty-mode client
  configuration and isolated working/base directory before a session starts.
- Application timeout calls `session.abort()`; stopping the wait is not treated
  as cancellation.
- Context Overflow emits no content telemetry by default.

## Residual risk

- Secret patterns are intentionally high-confidence and non-exhaustive.
- A reviewed redacted view can still contain non-secret sensitive context.
- Provider internals may transform an approved SDK prompt after the
  application passes it. The guarantee is the exact approved application
  payload hash passed to the SDK boundary, not provider-internal prompt bytes.
- Local compromise with arbitrary process/database access is outside the
  confidentiality boundary, but stored corruption is expected to fail
  integrity validation.
