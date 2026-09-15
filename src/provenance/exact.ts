import { realpathSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import type {
  FeatureProvider,
  ProducerMetadata,
  SourceAdapter
} from "../contracts/providers.js";
import type {
  ApprovedSourceCandidate,
  ExactSourceOccurrence,
  GitObjectIdentity,
  SourceLink,
  SourceProvenanceResult,
  SourceSnapshotIdentity
} from "../contracts/provenance.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import {
  deterministicUuid,
  sha256Base64Url
} from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";

export interface ExactSourceRequest {
  readonly query: Buffer;
  readonly candidates: readonly ApprovedSourceCandidate[];
}

export interface LocalSourceRequest {
  readonly paths: readonly string[];
  readonly approvedPaths: ReadonlySet<string>;
  readonly includeGitIdentity?: boolean;
}

function producer(
  producerId: string,
  kind: ProducerMetadata["kind"],
  version: string,
  contract: unknown
): ProducerMetadata {
  return {
    producerId,
    kind,
    version,
    digest: canonicalJsonDigest({ producerId, kind, version, contract })
  };
}

function identityFor(
  bytes: Buffer,
  git?: GitObjectIdentity
): SourceSnapshotIdentity {
  return {
    sha256: sha256Base64Url(bytes),
    byteLength: bytes.length,
    ...(git === undefined ? {} : { git })
  };
}

export function enumerateExactOccurrences(
  haystack: Buffer,
  needle: Buffer
): readonly number[] {
  if (needle.length === 0) return [];
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) break;
    offsets.push(found);
    cursor = found + 1;
  }
  return offsets;
}

export class ExactSourceProvenanceProvider
  implements FeatureProvider<ExactSourceRequest, SourceProvenanceResult>
{
  readonly metadata = producer(
    "builtin.cq01.exact-source-provenance",
    "feature-provider",
    "1.0.0",
    ["approved-only", "buffer-exact", "all-occurrences", "no-fuzzy-authority"]
  );

  provide(request: ExactSourceRequest): Result<SourceProvenanceResult> {
    if (request.query.length === 0) {
      return failure(
        "INVALID_ARGUMENT",
        "Exact source provenance requires non-empty query bytes"
      );
    }
    const querySha256 = sha256Base64Url(request.query);
    const occurrences: ExactSourceOccurrence[] = [];
    for (const candidate of [...request.candidates].sort((left, right) =>
      left.candidateId.localeCompare(right.candidateId)
    )) {
      if (!candidate.approved) continue;
      if (
        candidate.identity.byteLength !== candidate.bytes.length ||
        candidate.identity.sha256 !== sha256Base64Url(candidate.bytes)
      ) {
        return failure(
          "INTEGRITY_ERROR",
          "Approved source candidate identity is invalid",
          { candidateId: candidate.candidateId }
        );
      }
      for (const startByte of enumerateExactOccurrences(
        candidate.bytes,
        request.query
      )) {
        const endByte = startByte + request.query.length;
        occurrences.push({
          occurrenceId: deterministicUuid(
            `${candidate.candidateId}:${querySha256}:${startByte}:${endByte}`
          ),
          candidateId: candidate.candidateId,
          startByte,
          endByte,
          candidateIdentity: candidate.identity
        });
      }
    }
    return success({
      state:
        occurrences.length === 0
          ? "no-match"
          : occurrences.length === 1
            ? "unique"
            : "ambiguous",
      querySha256,
      queryByteLength: request.query.length,
      occurrences,
      producer: this.metadata,
      authoritative: true
    });
  }
}

function gitText(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function captureGitIdentity(path: string): Result<GitObjectIdentity> {
  try {
    const sourceDirectory = dirname(path);
    const repositoryRoot = gitText(sourceDirectory, [
      "rev-parse",
      "--show-toplevel"
    ]);
    const prefix = gitText(sourceDirectory, [
      "rev-parse",
      "--show-prefix"
    ]);
    const repositoryPath = `${prefix}${basename(path)}`.replace(/\\/g, "/");
    const commit = gitText(repositoryRoot, ["rev-parse", "HEAD"]);
    const tree = gitText(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
    const entry = gitText(repositoryRoot, [
      "ls-tree",
      "HEAD",
      "--",
      repositoryPath
    ]);
    const match = /^(\d+)\s+\w+\s+([0-9a-f]{40})\t/.exec(entry);
    if (match?.[1] === undefined || match[2] === undefined) {
      return failure("IO_ERROR", "Source path is not tracked at HEAD", {
        path,
        repositoryRoot
      });
    }
    const worktreeBlob = gitText(repositoryRoot, [
      "hash-object",
      "--",
      repositoryPath
    ]);
    return success({
      repositoryRoot,
      commit,
      tree,
      blob: match[2],
      path: repositoryPath,
      mode: match[1],
      worktreeMatchesBlob: worktreeBlob === match[2]
    });
  } catch (error) {
    return failure("IO_ERROR", "Unable to capture requested Git identity", {
      path,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

export class LocalApprovedSourceAdapter
  implements
    SourceAdapter<LocalSourceRequest, readonly ApprovedSourceCandidate[]>
{
  readonly metadata = producer(
    "builtin.cq01.local-source-adapter",
    "source-adapter",
    "1.0.0",
    ["realpath", "raw-bytes", "explicit-approval", "optional-git-identity"]
  );

  async capture(
    request: LocalSourceRequest
  ): Promise<Result<readonly ApprovedSourceCandidate[]>> {
    const candidates: ApprovedSourceCandidate[] = [];
    for (const requestedPath of request.paths) {
      const absolute = resolve(requestedPath);
      const canonicalPath = realpathSync(absolute);
      const approved =
        request.approvedPaths.has(absolute) ||
        request.approvedPaths.has(canonicalPath);
      if (!approved) {
        return failure("INVALID_ARGUMENT", "Source path was not approved", {
          requestedPath: absolute,
          canonicalPath
        });
      }
      const bytes = readFileSync(canonicalPath);
      let git: GitObjectIdentity | undefined;
      if (request.includeGitIdentity === true) {
        const capturedGit = captureGitIdentity(canonicalPath);
        if (!capturedGit.ok) return capturedGit;
        git = capturedGit.value;
      }
      const identity = identityFor(bytes, git);
      candidates.push({
        candidateId: deterministicUuid(
          `${canonicalPath}:${identity.sha256}:${identity.byteLength}`
        ),
        label: canonicalPath,
        canonicalPath,
        approved: true,
        bytes,
        identity
      });
    }
    return success(candidates);
  }
}

export function validateSourceProvenance(
  result: SourceProvenanceResult,
  query: Buffer,
  candidates: readonly ApprovedSourceCandidate[]
): Result<void> {
  const provider = new ExactSourceProvenanceProvider();
  const recomputed = provider.provide({ query, candidates });
  if (!recomputed.ok) return recomputed;
  if (
    canonicalJsonDigest(result) !== canonicalJsonDigest(recomputed.value)
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Source provenance is stale or candidate bytes changed"
    );
  }
  return success(undefined);
}

export function renderUniqueSourceLink(
  result: SourceProvenanceResult,
  candidates: readonly ApprovedSourceCandidate[]
): Result<SourceLink> {
  if (result.state !== "unique" || result.occurrences.length !== 1) {
    return failure(
      "INVALID_ARGUMENT",
      "Source-linked rendering requires one exact occurrence",
      { state: result.state, occurrences: result.occurrences.length }
    );
  }
  const occurrence = result.occurrences[0];
  const candidate = candidates.find(
    (item) => item.candidateId === occurrence?.candidateId
  );
  if (occurrence === undefined || candidate === undefined) {
    return failure(
      "INTEGRITY_ERROR",
      "Unique provenance occurrence has no approved candidate"
    );
  }
  if (
    !candidate.approved ||
    candidate.identity.sha256 !== sha256Base64Url(candidate.bytes) ||
    candidate.identity.byteLength !== candidate.bytes.length ||
    occurrence.candidateIdentity.sha256 !== candidate.identity.sha256 ||
    occurrence.candidateIdentity.byteLength !== candidate.identity.byteLength ||
    occurrence.endByte - occurrence.startByte !== result.queryByteLength ||
    sha256Base64Url(
      candidate.bytes.subarray(
        occurrence.startByte,
        occurrence.endByte
      )
    ) !== result.querySha256 ||
    occurrence.occurrenceId !==
      deterministicUuid(
        `${candidate.candidateId}:${result.querySha256}:${occurrence.startByte}:${occurrence.endByte}`
      )
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Source-linked rendering failed exact candidate revalidation"
    );
  }
  const git = candidate.identity.git;
  const rendered =
    git === undefined || !git.worktreeMatchesBlob
      ? `[SOURCE WORKTREE ${candidate.label} bytes=${occurrence.startByte}-${occurrence.endByte} sha256=${result.querySha256}]`
      : `[SOURCE ${git.path}@${git.commit} blob=${git.blob} mode=${git.mode} bytes=${occurrence.startByte}-${occurrence.endByte} sha256=${result.querySha256}]`;
  return success({
    occurrenceId: occurrence.occurrenceId,
    candidateId: candidate.candidateId,
    label: candidate.label,
    startByte: occurrence.startByte,
    endByte: occurrence.endByte,
    sha256: result.querySha256,
    ...(git === undefined || !git.worktreeMatchesBlob ? {} : { git }),
    rendered
  });
}

export const exactSourceProvenanceProvider =
  new ExactSourceProvenanceProvider();
export const localApprovedSourceAdapter = new LocalApprovedSourceAdapter();
