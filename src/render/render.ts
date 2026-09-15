import type {
  ArtifactSnapshot,
  EvidenceOutputMapping,
  EvidenceSpan,
  OmissionRecord,
  OutputMapping,
  PlannedTransform
} from "../contracts/types.js";
import { sha256Text } from "../core/hash.js";

export interface RenderResult {
  readonly preparedBytes: Buffer;
  readonly outputMappings: readonly OutputMapping[];
  readonly evidenceMappings: readonly EvidenceOutputMapping[];
  readonly omissions: readonly OmissionRecord[];
}

function safeLabel(label: string): string {
  return label.replace(/[\r\n]+/g, " ").slice(0, 240);
}

export function renderContext(
  artifacts: readonly ArtifactSnapshot[],
  plans: ReadonlyMap<string, readonly PlannedTransform[]>,
  evidence: readonly EvidenceSpan[]
): RenderResult {
  const chunks: Buffer[] = [];
  const mappings: OutputMapping[] = [];
  const omissions: OmissionRecord[] = [];
  let outputOffset = 0;

  const append = (
    bytes: Buffer,
    mapping: Omit<OutputMapping, "mappingId" | "ordinal" | "outputStartByte" | "outputEndByte">
  ): void => {
    const ordinal = mappings.length;
    const outputStartByte = outputOffset;
    chunks.push(bytes);
    outputOffset += bytes.length;
    mappings.push({
      ...mapping,
      mappingId: `mapping:${sha256Text(
        `${ordinal}:${mapping.kind}:${mapping.artifactId ?? "synthetic"}:${mapping.sourceStartByte ?? -1}:${mapping.sourceEndByte ?? -1}:${outputStartByte}:${outputOffset}`
      )}`,
      ordinal,
      outputStartByte,
      outputEndByte: outputOffset
    });
  };

  for (const artifact of [...artifacts].sort(
    (left, right) => left.ordinal - right.ordinal
  )) {
    const header = Buffer.from(
      `[CTXO ARTIFACT id=${artifact.artifactId} role=${artifact.role} label=${JSON.stringify(
        safeLabel(artifact.source.label)
      )}]\n`,
      "utf8"
    );
    append(header, { kind: "synthetic" });

    const transforms = [...(plans.get(artifact.artifactId) ?? [])].sort(
      (left, right) =>
        left.startByte - right.startByte || left.endByte - right.endByte
    );
    let sourceOffset = 0;
    for (const transform of transforms) {
      if (sourceOffset < transform.startByte) {
        append(
          artifact.bytes.subarray(sourceOffset, transform.startByte),
          {
            kind: "literal",
            artifactId: artifact.artifactId,
            sourceStartByte: sourceOffset,
            sourceEndByte: transform.startByte
          }
        );
      }
      const markerBytes = Buffer.from(transform.marker, "utf8");
      append(markerBytes, {
        kind: "omission",
        artifactId: artifact.artifactId,
        sourceStartByte: transform.startByte,
        sourceEndByte: transform.endByte,
        handle: transform.handle
      });
      omissions.push({
        occurrenceId: transform.occurrenceId,
        artifactId: artifact.artifactId,
        startByte: transform.startByte,
        endByte: transform.endByte,
        handle: transform.handle,
        sha256: transform.omittedSha256,
        byteLength: transform.omittedByteLength,
        reason: transform.reason,
        marker: transform.marker,
        sourceCount: transform.sourceCount
      });
      sourceOffset = transform.endByte;
    }
    if (sourceOffset < artifact.byteLength) {
      append(artifact.bytes.subarray(sourceOffset), {
        kind: "literal",
        artifactId: artifact.artifactId,
        sourceStartByte: sourceOffset,
        sourceEndByte: artifact.byteLength
      });
    }
    append(Buffer.from("\n", "utf8"), { kind: "synthetic" });
  }

  const preparedBytes = Buffer.concat(chunks);
  const evidenceMappings = evidence
    .filter((item) => item.mandatoryInline)
    .map((item): EvidenceOutputMapping => {
    const literal = mappings.find(
      (mapping) =>
        mapping.kind === "literal" &&
        mapping.artifactId === item.artifactId &&
        mapping.sourceStartByte !== undefined &&
        mapping.sourceEndByte !== undefined &&
        mapping.sourceStartByte <= item.startByte &&
        mapping.sourceEndByte >= item.endByte
    );
    if (
      literal === undefined ||
      literal.sourceStartByte === undefined
    ) {
      throw new Error(
        `Protected evidence ${item.evidenceId} has no containing literal mapping`
      );
    }
    const outputStartByte =
      literal.outputStartByte + item.startByte - literal.sourceStartByte;
    return {
      evidenceId: item.evidenceId,
      occurrenceId: item.occurrenceId,
      artifactId: item.artifactId,
      sourceStartByte: item.startByte,
      sourceEndByte: item.endByte,
      outputStartByte,
      outputEndByte: outputStartByte + item.endByte - item.startByte,
      sha256: item.sha256
    };
    });

  return {
    preparedBytes,
    outputMappings: mappings,
    evidenceMappings,
    omissions
  };
}
