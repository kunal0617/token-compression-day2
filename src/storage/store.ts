import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalManifestSchema,
  contextReceiptSchema
} from "../contracts/schemas.js";
import type {
  ArtifactClassification,
  ArtifactSnapshot,
  CanonicalManifest,
  ContextPackage,
  ContextReceipt,
  EvidenceOutputMapping,
  EvidenceSpan,
  OmissionRecord,
  OutputMapping,
  ValidatedContextPackage
} from "../contracts/types.js";
import { canonicalJson } from "../core/canonical.js";
import { sha256Base64Url } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";
import { buildReceipt } from "../receipt/receipt.js";
import { parseHandle } from "./handles.js";
import { validateContextPackage } from "../validate/validate.js";

export interface StoreCommitInput {
  readonly runId: string;
  readonly createdAt: string;
  readonly artifacts: readonly ArtifactSnapshot[];
  readonly classifications: ReadonlyMap<string, ArtifactClassification>;
  readonly evidence: readonly EvidenceSpan[];
  readonly omissions: readonly OmissionRecord[];
  readonly outputMappings: readonly OutputMapping[];
  readonly evidenceMappings: readonly EvidenceOutputMapping[];
  readonly manifest: CanonicalManifest;
  readonly manifestJson: string;
  readonly manifestSha256: string;
  readonly preparedBytes: Buffer;
}

interface BlobRow {
  readonly digest: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

interface RunRow {
  readonly status: string;
  readonly validation_status: string;
  readonly manifest_hash: string | null;
  readonly compact_hash: string | null;
  readonly receipt_json: string | null;
}

interface ManifestRow {
  readonly canonical_json: string;
  readonly digest: string;
  readonly manifest_hash: string | null;
  readonly run_id: string;
}

interface ArtifactBlobRow {
  readonly artifact_id: string;
  readonly bytes: Uint8Array;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ContextStore {
  readonly path: string;
  readonly #database: DatabaseSync;
  #validationRunId: string | undefined;

  constructor(path: string) {
    if (path.trim().length === 0 || path === ":memory:") {
      throw new TypeError("A durable on-disk SQLite path is required");
    }
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.#database = new DatabaseSync(this.path);
    this.#configure();
    this.#createSchema();
  }

  #configure(): void {
    this.#database.exec("PRAGMA foreign_keys=ON");
    this.#database.exec("PRAGMA journal_mode=WAL");
    this.#database.exec("PRAGMA synchronous=FULL");
    this.#database.exec("PRAGMA busy_timeout=5000");

    const foreignKeys = this.#database
      .prepare("PRAGMA foreign_keys")
      .get() as { foreign_keys: number } | undefined;
    const journal = this.#database
      .prepare("PRAGMA journal_mode")
      .get() as { journal_mode: string } | undefined;
    const synchronous = this.#database
      .prepare("PRAGMA synchronous")
      .get() as { synchronous: number } | undefined;
    if (
      foreignKeys?.foreign_keys !== 1 ||
      journal?.journal_mode.toLowerCase() !== "wal" ||
      synchronous?.synchronous !== 2
    ) {
      throw new Error("SQLite durability pragmas were not applied");
    }
  }

  #createSchema(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('staging', 'committed', 'failed')),
        validation_status TEXT NOT NULL CHECK(validation_status IN ('pending', 'validated', 'failed')),
        created_at TEXT NOT NULL,
        committed_at TEXT,
        manifest_hash TEXT,
        compact_hash TEXT,
        original_bytes INTEGER NOT NULL,
        prepared_bytes INTEGER NOT NULL,
        original_tokens INTEGER NOT NULL,
        prepared_tokens INTEGER NOT NULL,
        receipt_json TEXT,
        error TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS blobs (
        digest TEXT PRIMARY KEY,
        size INTEGER NOT NULL CHECK(size >= 0),
        bytes BLOB NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifacts (
        run_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        source_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        utf8 TEXT NOT NULL,
        has_bom INTEGER NOT NULL,
        newline_style TEXT NOT NULL,
        has_ansi INTEGER NOT NULL,
        completeness TEXT NOT NULL,
        completeness_reason TEXT NOT NULL,
        classification_json TEXT NOT NULL,
        PRIMARY KEY(run_id, artifact_id),
        UNIQUE(run_id, ordinal),
        FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
        FOREIGN KEY(digest) REFERENCES blobs(digest)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS omissions (
        run_id TEXT NOT NULL,
        occurrence_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        start_byte INTEGER NOT NULL,
        end_byte INTEGER NOT NULL,
        handle TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        size INTEGER NOT NULL,
        reason TEXT NOT NULL,
        marker TEXT NOT NULL,
        source_count INTEGER NOT NULL,
        PRIMARY KEY(run_id, occurrence_id),
        FOREIGN KEY(run_id, artifact_id) REFERENCES artifacts(run_id, artifact_id),
        FOREIGN KEY(digest) REFERENCES blobs(digest)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS evidence (
        run_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        occurrence_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        start_byte INTEGER NOT NULL,
        end_byte INTEGER NOT NULL,
        kind TEXT NOT NULL,
        digest TEXT NOT NULL,
        mandatory_inline INTEGER NOT NULL,
        protection_reasons_json TEXT NOT NULL,
        PRIMARY KEY(run_id, evidence_id),
        UNIQUE(run_id, occurrence_id),
        FOREIGN KEY(run_id, artifact_id) REFERENCES artifacts(run_id, artifact_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS output_mappings (
        run_id TEXT NOT NULL,
        mapping_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        artifact_id TEXT,
        source_start_byte INTEGER,
        source_end_byte INTEGER,
        output_start_byte INTEGER NOT NULL,
        output_end_byte INTEGER NOT NULL,
        kind TEXT NOT NULL,
        handle TEXT,
        PRIMARY KEY(run_id, mapping_id),
        UNIQUE(run_id, ordinal),
        FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
        FOREIGN KEY(run_id, artifact_id) REFERENCES artifacts(run_id, artifact_id),
        FOREIGN KEY(handle) REFERENCES omissions(handle)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS evidence_mappings (
        run_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        occurrence_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        source_start_byte INTEGER NOT NULL,
        source_end_byte INTEGER NOT NULL,
        output_start_byte INTEGER NOT NULL,
        output_end_byte INTEGER NOT NULL,
        digest TEXT NOT NULL,
        PRIMARY KEY(run_id, evidence_id),
        UNIQUE(run_id, occurrence_id),
        FOREIGN KEY(run_id, evidence_id) REFERENCES evidence(run_id, evidence_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS manifests (
        run_id TEXT PRIMARY KEY,
        canonical_json TEXT NOT NULL,
        digest TEXT NOT NULL UNIQUE,
        FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      ) STRICT;
    `);
  }

  #putBlob(digest: string, bytes: Buffer): void {
    if (sha256Base64Url(bytes) !== digest) {
      throw new Error("Attempted to store bytes under the wrong digest");
    }
    const existing = this.#database
      .prepare("SELECT digest, size, bytes FROM blobs WHERE digest = ?")
      .get(digest) as BlobRow | undefined;
    if (existing !== undefined) {
      const existingBytes = Buffer.from(existing.bytes);
      if (
        existing.size !== bytes.length ||
        sha256Base64Url(existingBytes) !== digest ||
        !existingBytes.equals(bytes)
      ) {
        throw new Error(`Existing content-addressed blob is corrupt: ${digest}`);
      }
      return;
    }
    this.#database
      .prepare("INSERT INTO blobs(digest, size, bytes) VALUES (?, ?, ?)")
      .run(digest, bytes.length, bytes);
  }

  stageRun(input: StoreCommitInput): Result<void> {
    if (
      input.manifest.runId !== input.runId ||
      sha256Base64Url(Buffer.from(input.manifestJson, "utf8")) !==
        input.manifestSha256
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Staging input run or manifest digest binding is invalid",
        { runId: input.runId }
      );
    }
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const originalBytes = input.artifacts.reduce(
        (total, artifact) => total + artifact.byteLength,
        0
      );
      this.#database
        .prepare(
          `INSERT INTO runs(
            run_id, status, validation_status, created_at, original_bytes,
            prepared_bytes, original_tokens, prepared_tokens
          ) VALUES (?, 'staging', 'pending', ?, ?, ?, ?, ?)`
        )
        .run(
          input.runId,
          input.createdAt,
          originalBytes,
          input.preparedBytes.length,
          input.manifest.tokenizer.originalTokens,
          input.manifest.tokenizer.preparedTokens
        );

      for (const artifact of input.artifacts) {
        this.#putBlob(artifact.sha256, artifact.bytes);
        const classification = input.classifications.get(artifact.artifactId);
        if (classification === undefined) {
          throw new Error(`Missing classification for ${artifact.artifactId}`);
        }
        this.#database
          .prepare(
            `INSERT INTO artifacts(
              run_id, artifact_id, ordinal, role, source_json, digest,
              byte_length, utf8, has_bom, newline_style, has_ansi,
              completeness, completeness_reason, classification_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.runId,
            artifact.artifactId,
            artifact.ordinal,
            artifact.role,
            canonicalJson(artifact.source),
            artifact.sha256,
            artifact.byteLength,
            artifact.utf8,
            artifact.hasBom ? 1 : 0,
            artifact.newlineStyle,
            artifact.hasAnsi ? 1 : 0,
            artifact.completeness,
            artifact.completenessReason,
            canonicalJson(classification)
          );
      }

      for (const omission of input.omissions) {
        const parsed = parseHandle(omission.handle);
        if (!parsed.ok) throw new Error(parsed.error.message);
        const artifact = input.artifacts.find(
          (candidate) => candidate.artifactId === omission.artifactId
        );
        if (artifact === undefined) {
          throw new Error(`Unknown omission artifact ${omission.artifactId}`);
        }
        const bytes = artifact.bytes.subarray(
          omission.startByte,
          omission.endByte
        );
        this.#putBlob(omission.sha256, bytes);
        this.#database
          .prepare(
            `INSERT INTO omissions(
              run_id, occurrence_id, artifact_id, start_byte, end_byte,
              handle, digest, size, reason, marker, source_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.runId,
            omission.occurrenceId,
            omission.artifactId,
            omission.startByte,
            omission.endByte,
            omission.handle,
            omission.sha256,
            omission.byteLength,
            omission.reason,
            omission.marker,
            omission.sourceCount
          );
      }

      for (const item of input.evidence) {
        this.#database
          .prepare(
            `INSERT INTO evidence(
              run_id, evidence_id, occurrence_id, artifact_id, start_byte,
              end_byte, kind, digest, mandatory_inline, protection_reasons_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.runId,
            item.evidenceId,
            item.occurrenceId,
            item.artifactId,
            item.startByte,
            item.endByte,
            item.kind,
            item.sha256,
            item.mandatoryInline ? 1 : 0,
            canonicalJson(item.protectionReasons)
          );
      }

      for (const mapping of input.outputMappings) {
        this.#database
          .prepare(
            `INSERT INTO output_mappings(
              run_id, mapping_id, ordinal, artifact_id, source_start_byte,
              source_end_byte, output_start_byte, output_end_byte, kind, handle
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.runId,
            mapping.mappingId,
            mapping.ordinal,
            mapping.artifactId ?? null,
            mapping.sourceStartByte ?? null,
            mapping.sourceEndByte ?? null,
            mapping.outputStartByte,
            mapping.outputEndByte,
            mapping.kind,
            mapping.handle ?? null
          );
      }

      for (const mapping of input.evidenceMappings) {
        this.#database
          .prepare(
            `INSERT INTO evidence_mappings(
              run_id, evidence_id, occurrence_id, artifact_id,
              source_start_byte, source_end_byte, output_start_byte,
              output_end_byte, digest
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.runId,
            mapping.evidenceId,
            mapping.occurrenceId,
            mapping.artifactId,
            mapping.sourceStartByte,
            mapping.sourceEndByte,
            mapping.outputStartByte,
            mapping.outputEndByte,
            mapping.sha256
          );
      }

      this.#putBlob(input.manifest.compactSha256, input.preparedBytes);
      this.#database
        .prepare(
          "INSERT INTO manifests(run_id, canonical_json, digest) VALUES (?, ?, ?)"
        )
        .run(input.runId, input.manifestJson, input.manifestSha256);
      this.#database
        .prepare(
          `UPDATE runs
           SET manifest_hash=?, compact_hash=?
           WHERE run_id=? AND status='staging' AND validation_status='pending'`
        )
        .run(input.manifestSha256, input.manifest.compactSha256, input.runId);
      this.#database.exec("COMMIT");
      return success(undefined);
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // SQLite reports no active transaction after failures that auto-rollback.
      }
      const message = errorMessage(error);
      try {
        this.#database
          .prepare(
            `INSERT INTO runs(
              run_id, status, validation_status, created_at, original_bytes,
              prepared_bytes, original_tokens, prepared_tokens, error
            ) VALUES (?, 'failed', 'failed', ?, 0, 0, 0, 0, ?)
            ON CONFLICT(run_id) DO NOTHING`
          )
          .run(input.runId, input.createdAt, message);
      } catch {
        return failure("STORAGE_ERROR", "Run transaction failed and failure state could not be recorded", {
          cause: message
        });
      }
      return failure("STORAGE_ERROR", "Run transaction failed", {
        cause: message,
        runId: input.runId
      });
    }
  }

  retrieve(handle: string): Result<Buffer> {
    const parsed = parseHandle(handle);
    if (!parsed.ok) return parsed;
    try {
      const row = this.#database
        .prepare(
          `SELECT b.digest, b.size, b.bytes
           FROM omissions o
           JOIN blobs b ON b.digest = o.digest
           JOIN runs r ON r.run_id = o.run_id
           WHERE o.handle = ? AND o.occurrence_id = ?
             AND o.digest = ? AND o.size = ?
             AND r.status = 'committed' AND r.validation_status = 'validated'`
        )
        .get(
          handle,
          parsed.value.occurrenceId,
          parsed.value.digest,
          parsed.value.byteLength
        ) as BlobRow | undefined;
      if (row === undefined) {
        return failure(
          "HANDLE_NOT_FOUND",
          "Handle does not resolve in a committed validated run",
          { handle }
        );
      }
      const bytes = Buffer.from(row.bytes);
      if (
        row.size !== parsed.value.byteLength ||
        bytes.length !== parsed.value.byteLength ||
        row.digest !== parsed.value.digest ||
        sha256Base64Url(bytes) !== parsed.value.digest
      ) {
        return failure(
          "INTEGRITY_ERROR",
          "Retrieved blob failed size or digest validation",
          { handle }
        );
      }
      return success(bytes);
    } catch (error) {
      return failure("STORAGE_ERROR", "Handle retrieval failed", {
        handle,
        cause: errorMessage(error)
      });
    }
  }

  retrieveForValidation(runId: string, handle: string): Result<Buffer> {
    const parsed = parseHandle(handle);
    if (!parsed.ok) return parsed;
    try {
      const row = this.#database
        .prepare(
          `SELECT b.digest, b.size, b.bytes
           FROM omissions o
           JOIN blobs b ON b.digest = o.digest
           JOIN runs r ON r.run_id = o.run_id
           WHERE o.run_id = ? AND o.handle = ? AND o.occurrence_id = ?
             AND o.digest = ? AND o.size = ?
             AND r.status = 'staging' AND r.validation_status = 'pending'`
        )
        .get(
          runId,
          handle,
          parsed.value.occurrenceId,
          parsed.value.digest,
          parsed.value.byteLength
        ) as BlobRow | undefined;
      if (row === undefined) {
        return failure(
          "HANDLE_NOT_FOUND",
          "Handle does not resolve in the staging run",
          { runId, handle }
        );
      }
      const bytes = Buffer.from(row.bytes);
      if (
        row.size !== parsed.value.byteLength ||
        bytes.length !== parsed.value.byteLength ||
        row.digest !== parsed.value.digest ||
        sha256Base64Url(bytes) !== parsed.value.digest
      ) {
        return failure(
          "INTEGRITY_ERROR",
          "Staging blob failed size or digest validation",
          { runId, handle }
        );
      }
      return success(bytes);
    } catch (error) {
      return failure("STORAGE_ERROR", "Staging handle retrieval failed", {
        runId,
        handle,
        cause: errorMessage(error)
      });
    }
  }

  getRunState(runId: string): Result<{
    status: "staging" | "committed" | "failed";
    validationStatus: "pending" | "validated" | "failed";
  }> {
    try {
      const row = this.#database
        .prepare(
          "SELECT status, validation_status, manifest_hash, compact_hash, receipt_json FROM runs WHERE run_id=?"
        )
        .get(runId) as RunRow | undefined;
      if (row === undefined) {
        return failure("HANDLE_NOT_FOUND", "Run was not found", { runId });
      }
      if (
        !["staging", "committed", "failed"].includes(row.status) ||
        !["pending", "validated", "failed"].includes(row.validation_status)
      ) {
        return failure("INTEGRITY_ERROR", "Run state contains invalid values", {
          runId
        });
      }
      return success({
        status: row.status as "staging" | "committed" | "failed",
        validationStatus: row.validation_status as
          | "pending"
          | "validated"
          | "failed"
      });
    } catch (error) {
      return failure("STORAGE_ERROR", "Unable to read run state", {
        runId,
        cause: errorMessage(error)
      });
    }
  }

  loadManifest(runId: string): Result<{
    manifest: CanonicalManifest;
    manifestJson: string;
    manifestSha256: string;
  }> {
    return this.#loadManifestByState(runId, "committed");
  }

  loadManifestForValidation(runId: string): Result<{
    manifest: CanonicalManifest;
    manifestJson: string;
    manifestSha256: string;
  }> {
    return this.#loadManifestByState(runId, "staging");
  }

  #loadManifestByState(
    runId: string,
    state: "staging" | "committed"
  ): Result<{
    manifest: CanonicalManifest;
    manifestJson: string;
    manifestSha256: string;
  }> {
    const validationStatus = state === "staging" ? "pending" : "validated";
    try {
      const row = this.#database
        .prepare(
          `SELECT m.canonical_json, m.digest, r.manifest_hash, r.run_id
           FROM manifests m
           JOIN runs r ON r.run_id = m.run_id
           WHERE m.run_id=? AND r.status=? AND r.validation_status=?`
        )
        .get(runId, state, validationStatus) as ManifestRow | undefined;
      if (row === undefined) {
        return failure("RUN_NOT_COMMITTED", `${state} manifest was not found`, {
          runId
        });
      }
      if (sha256Base64Url(Buffer.from(row.canonical_json, "utf8")) !== row.digest) {
        return failure("INTEGRITY_ERROR", "Canonical manifest digest mismatch", {
          runId
        });
      }
      if (row.manifest_hash !== row.digest || row.run_id !== runId) {
        return failure(
          "INTEGRITY_ERROR",
          "Run manifest hash binding is invalid",
          { runId }
        );
      }
      const parsedJson: unknown = JSON.parse(row.canonical_json);
      const parsed = canonicalManifestSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return failure("INTEGRITY_ERROR", "Canonical manifest schema validation failed", {
          runId,
          issues: parsed.error.issues.map((issue) => issue.message)
        });
      }
      if (parsed.data.runId !== runId) {
        return failure("INTEGRITY_ERROR", "Manifest run ID binding is invalid", {
          runId,
          manifestRunId: parsed.data.runId
        });
      }
      if (canonicalJson(parsed.data) !== row.canonical_json) {
        return failure("INTEGRITY_ERROR", "Manifest is not in canonical JSON form", {
          runId
        });
      }
      return success({
        manifest: parsed.data as CanonicalManifest,
        manifestJson: row.canonical_json,
        manifestSha256: row.digest
      });
    } catch (error) {
      return failure("STORAGE_ERROR", "Unable to load canonical manifest", {
        runId,
        cause: errorMessage(error)
      });
    }
  }

  loadPreparedBytes(runId: string): Result<Buffer> {
    return this.#loadPreparedBytesByState(runId, "committed");
  }

  loadPreparedBytesForValidation(runId: string): Result<Buffer> {
    return this.#loadPreparedBytesByState(runId, "staging");
  }

  #loadPreparedBytesByState(
    runId: string,
    state: "staging" | "committed"
  ): Result<Buffer> {
    const validationStatus = state === "staging" ? "pending" : "validated";
    try {
      const row = this.#database
        .prepare(
          `SELECT b.digest, b.size, b.bytes
           FROM runs r JOIN blobs b ON b.digest = r.compact_hash
           WHERE r.run_id=? AND r.status=? AND r.validation_status=?`
        )
        .get(runId, state, validationStatus) as BlobRow | undefined;
      if (row === undefined) {
        return failure("RUN_NOT_COMMITTED", `${state} output was not found`, {
          runId
        });
      }
      const bytes = Buffer.from(row.bytes);
      if (bytes.length !== row.size || sha256Base64Url(bytes) !== row.digest) {
        return failure("INTEGRITY_ERROR", "Prepared output blob is corrupt", {
          runId
        });
      }
      return success(bytes);
    } catch (error) {
      return failure("STORAGE_ERROR", "Unable to load prepared output", {
        runId,
        cause: errorMessage(error)
      });
    }
  }

  loadArtifactBytes(runId: string): Result<ReadonlyMap<string, Buffer>> {
    try {
      const rows = this.#database
        .prepare(
          `SELECT a.artifact_id, b.bytes
           FROM artifacts a
           JOIN blobs b ON b.digest = a.digest
           JOIN runs r ON r.run_id = a.run_id
           WHERE a.run_id=? AND r.status='committed'
             AND r.validation_status='validated'
           ORDER BY a.ordinal`
        )
        .all(runId) as unknown as ArtifactBlobRow[];
      return success(
        new Map(rows.map((row) => [row.artifact_id, Buffer.from(row.bytes)]))
      );
    } catch (error) {
      return failure("STORAGE_ERROR", "Unable to load artifact bytes", {
        runId,
        cause: errorMessage(error)
      });
    }
  }

  beginValidation(runId: string): Result<void> {
    if (this.#validationRunId !== undefined) {
      return failure("STORAGE_ERROR", "A validation transaction is already active", {
        activeRunId: this.#validationRunId
      });
    }
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const row = this.#database
        .prepare(
          `SELECT run_id FROM runs
           WHERE run_id=? AND status='staging' AND validation_status='pending'`
        )
        .get(runId);
      if (row === undefined) {
        throw new Error("Run is not staging and pending validation");
      }
      this.#validationRunId = runId;
      return success(undefined);
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // SQLite reports no active transaction if BEGIN failed.
      }
      return failure("STORAGE_ERROR", "Unable to lock staging run for validation", {
        runId,
        cause: errorMessage(error)
      });
    }
  }

  #finalizeValidated(runId: string, receipt: ContextReceipt): Result<void> {
    if (this.#validationRunId !== runId) {
      return failure(
        "STORAGE_ERROR",
        "Run validation transaction is not active",
        { runId }
      );
    }
    try {
      const result = this.#database
        .prepare(
          `UPDATE runs
           SET status='committed', validation_status='validated',
               committed_at=?, receipt_json=?
           WHERE run_id=? AND status='staging' AND validation_status='pending'`
        )
        .run(new Date().toISOString(), canonicalJson(receipt), runId);
      if (result.changes !== 1) {
        throw new Error("Run was not staging and pending validation");
      }
      this.#database.exec("COMMIT");
      this.#validationRunId = undefined;
      return success(undefined);
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // SQLite reports no active transaction if BEGIN failed.
      }
      this.#validationRunId = undefined;
      return failure("STORAGE_ERROR", "Unable to finalize validated run", {
        runId,
        cause: errorMessage(error)
      });
    }
  }

  cancelValidation(runId: string, message: string): Result<void> {
    if (this.#validationRunId !== runId) {
      return this.markFailed(runId, message);
    }
    try {
      const result = this.#database
        .prepare(
          `UPDATE runs
           SET status='failed', validation_status='failed', error=?
           WHERE run_id=? AND status='staging'`
        )
        .run(message, runId);
      if (result.changes !== 1) {
        throw new Error("Staging run was not available to fail");
      }
      this.#database.exec("COMMIT");
      this.#validationRunId = undefined;
      return success(undefined);
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // SQLite reports no active transaction after an automatic rollback.
      }
      this.#validationRunId = undefined;
      return failure("STORAGE_ERROR", "Unable to fail validation transaction", {
        runId,
        cause: errorMessage(error)
      });
    }
  }

  publishValidated(input: {
    readonly contextPackage: ContextPackage;
    readonly artifacts: readonly ArtifactSnapshot[];
    readonly receipt: ContextReceipt;
  }): Result<ValidatedContextPackage> {
    const runId = input.contextPackage.runId;
    const receiptValidation = contextReceiptSchema.safeParse(input.receipt);
    if (!receiptValidation.success) {
      this.markFailed(runId, "Receipt contract validation failed");
      return failure("INTEGRITY_ERROR", "Receipt contract validation failed", {
        issues: receiptValidation.error.issues.map((issue) => issue.message)
      });
    }
    const locked = this.beginValidation(runId);
    if (!locked.ok) {
      this.markFailed(runId, locked.error.message);
      return locked;
    }
    const validated = validateContextPackage({
      contextPackage: input.contextPackage,
      artifacts: input.artifacts,
      store: this,
      phase: "staging"
    });
    if (!validated.ok) {
      const cancelled = this.cancelValidation(runId, validated.error.message);
      return cancelled.ok ? validated : cancelled;
    }
    const expectedReceipt = buildReceipt({
      runId,
      classifications: input.contextPackage.manifest.artifacts.map(
        (artifact) => artifact.classification
      ),
      intent: input.contextPackage.manifest.intent,
      outcome: input.contextPackage.manifest.outcome,
      originalBytes: input.contextPackage.manifest.originalByteLength,
      preparedBytes: input.contextPackage.manifest.compactByteLength,
      tokens: input.contextPackage.manifest.tokenizer,
      evidence: input.contextPackage.manifest.evidence,
      omissions: input.contextPackage.manifest.omissions,
      warnings: input.receipt.warnings
    });
    if (canonicalJson(expectedReceipt) !== canonicalJson(input.receipt)) {
      const message = "Receipt does not match the validated package";
      const cancelled = this.cancelValidation(runId, message);
      return cancelled.ok
        ? failure("INTEGRITY_ERROR", message)
        : cancelled;
    }
    const finalized = this.#finalizeValidated(runId, input.receipt);
    if (!finalized.ok) {
      this.markFailed(runId, finalized.error.message);
      return finalized;
    }
    return success({
      ...input.contextPackage,
      validation: {
        status: "validated",
        reconstruction: "byte-identical",
        committed: true
      }
    });
  }

  markFailed(runId: string, message: string): Result<void> {
    try {
      this.#database
        .prepare(
          `UPDATE runs
           SET status='failed', validation_status='failed', error=?
           WHERE run_id=? AND status='staging'`
        )
        .run(message, runId);
      return success(undefined);
    } catch (error) {
      return failure("STORAGE_ERROR", "Unable to mark run failed", {
        runId,
        cause: errorMessage(error)
      });
    }
  }

  inspectReceipt(runId: string): Result<ContextReceipt> {
    try {
      const row = this.#database
        .prepare(
          `SELECT receipt_json FROM runs
           WHERE run_id=? AND status='committed' AND validation_status='validated'`
        )
        .get(runId) as { receipt_json: string | null } | undefined;
      if (row?.receipt_json === null || row?.receipt_json === undefined) {
        return failure("RUN_NOT_COMMITTED", "Validated receipt was not found", {
          runId
        });
      }
      const parsedJson: unknown = JSON.parse(row.receipt_json);
      const parsed = contextReceiptSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return failure("INTEGRITY_ERROR", "Stored receipt schema is invalid", {
          runId,
          issues: parsed.error.issues.map((issue) => issue.message)
        });
      }
      if (canonicalJson(parsed.data) !== row.receipt_json) {
        return failure("INTEGRITY_ERROR", "Stored receipt is not canonical", {
          runId
        });
      }
      return success(parsed.data as ContextReceipt);
    } catch (error) {
      return failure("STORAGE_ERROR", "Unable to inspect receipt", {
        runId,
        cause: errorMessage(error)
      });
    }
  }

  close(): void {
    if (this.#validationRunId !== undefined) {
      this.#database.exec("ROLLBACK");
      this.#validationRunId = undefined;
    }
    this.#database.close();
  }
}
