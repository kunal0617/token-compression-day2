import type {
  CodeUnit,
  DeliveryPlan,
  DeliveryRoot,
  DeliveryRules,
  DeliverySlice,
  SemanticEdge,
  SourceDocument
} from "../contracts/source-scope.js";
import { sha256Base64Url } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";
import {
  conservativeFileStructureProvider,
  treeSitterJsTsStructureProvider
} from "./tree-sitter.js";
import { typeScriptSemanticEdgeProvider } from "./typescript-semantic.js";

function rangesIntersect(
  left: { startByte: number; endByte: number },
  right: { startByte: number; endByte: number }
): boolean {
  return left.startByte < right.endByte && right.startByte < left.endByte;
}

function rootUnits(
  root: DeliveryRoot,
  units: readonly CodeUnit[],
  document: SourceDocument
): readonly CodeUnit[] {
  const sourceUnits = units.filter((unit) => unit.sourceId === root.sourceId);
  if (root.symbol !== undefined) {
    return sourceUnits.filter((unit) => unit.name === root.symbol);
  }
  if (root.startByte !== undefined && root.endByte !== undefined) {
    return sourceUnits.filter((unit) =>
      rangesIntersect(unit, {
        startByte: root.startByte as number,
        endByte: root.endByte as number
      })
    );
  }
  return sourceUnits.length > 0
    ? sourceUnits
    : conservativeFileStructureProvider.units({ document }).ok
      ? (
          conservativeFileStructureProvider.units({ document }) as {
            ok: true;
            value: readonly CodeUnit[];
          }
        ).value
      : [];
}

function allowedEdge(edge: SemanticEdge, rules: DeliveryRules): boolean {
  return (
    (edge.kind === "import" && rules.includeImports) ||
    (edge.kind === "definition" && rules.includeDefinitions) ||
    (edge.kind === "type" && rules.includeTypes) ||
    (edge.kind === "test" && rules.includeTests)
  );
}

function mergeUnits(
  document: SourceDocument,
  units: readonly CodeUnit[]
): readonly DeliverySlice[] {
  const ordered = [...units].sort(
    (left, right) =>
      left.startByte - right.startByte || left.endByte - right.endByte
  );
  const groups: { start: number; end: number; unitIds: string[] }[] = [];
  for (const unit of ordered) {
    const previous = groups.at(-1);
    if (previous === undefined || unit.startByte > previous.end) {
      groups.push({
        start: unit.startByte,
        end: unit.endByte,
        unitIds: [unit.unitId]
      });
    } else {
      previous.end = Math.max(previous.end, unit.endByte);
      previous.unitIds.push(unit.unitId);
    }
  }
  return groups.map((group) => {
    const bytes = document.bytes.subarray(group.start, group.end);
    return {
      sourceId: document.sourceId,
      path: document.path,
      startByte: group.start,
      endByte: group.end,
      bytes,
      sha256: sha256Base64Url(bytes),
      unitIds: group.unitIds
    };
  });
}

export function buildDeliveryPlan(input: {
  readonly documents: readonly SourceDocument[];
  readonly roots: readonly DeliveryRoot[];
  readonly rules: DeliveryRules;
}): Result<DeliveryPlan> {
  if (
    input.rules.maxFiles <= 0 ||
    input.rules.maxBytes <= 0 ||
    input.rules.maxDepth < 0
  ) {
    return failure("INVALID_ARGUMENT", "Delivery rules have invalid bounds");
  }
  const documents = new Map(
    input.documents.map((document) => [document.sourceId, document])
  );
  const units: CodeUnit[] = [];
  const warnings: string[] = [];
  for (const document of input.documents) {
    const structured = treeSitterJsTsStructureProvider.units({ document });
    if (!structured.ok) return structured;
    if (structured.value.length > 0) {
      units.push(...structured.value);
    } else {
      const fallback = conservativeFileStructureProvider.units({ document });
      if (!fallback.ok) return fallback;
      units.push(...fallback.value);
      warnings.push(`Conservative whole-file fallback used for ${document.path}`);
    }
  }
  const semantic = typeScriptSemanticEdgeProvider.edges({
    documents: input.documents
  });
  if (!semantic.ok) return semantic;
  const selectedUnits = new Map<string, CodeUnit>();
  const selectedSources = new Set<string>();
  const queue: { sourceId: string; depth: number }[] = [];
  for (const root of input.roots) {
    const document = documents.get(root.sourceId);
    if (document === undefined) {
      return failure("INVALID_ARGUMENT", "Delivery root source was not found", {
        sourceId: root.sourceId
      });
    }
    const matches = rootUnits(root, units, document);
    if (matches.length === 0) {
      return failure("INVALID_ARGUMENT", "Delivery root matched no exact unit", {
        sourceId: root.sourceId,
        symbol: root.symbol ?? null
      });
    }
    for (const unit of matches) selectedUnits.set(unit.unitId, unit);
    selectedSources.add(root.sourceId);
    queue.push({ sourceId: root.sourceId, depth: 0 });
  }
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current.depth >= input.rules.maxDepth) continue;
    const candidateEdges = semantic.value.filter(
      (edge) =>
        allowedEdge(edge, input.rules) &&
        (edge.fromSourceId === current.sourceId ||
          (edge.kind === "test" && edge.toSourceId === current.sourceId))
    );
    for (const edge of candidateEdges) {
      const targetSourceId =
        edge.kind === "test" && edge.toSourceId === current.sourceId
          ? edge.fromSourceId
          : edge.toSourceId;
      if (!selectedSources.has(targetSourceId)) {
        if (selectedSources.size >= input.rules.maxFiles) {
          warnings.push(
            `File bound omitted semantic target ${targetSourceId}`
          );
          continue;
        }
        selectedSources.add(targetSourceId);
        queue.push({ sourceId: targetSourceId, depth: current.depth + 1 });
      }
      const targetUnits = units.filter(
        (unit) =>
          unit.sourceId === targetSourceId &&
          rangesIntersect(unit, {
            startByte: edge.toStartByte,
            endByte: edge.toEndByte
          })
      );
      for (const unit of targetUnits) selectedUnits.set(unit.unitId, unit);
    }
  }
  const slices: DeliverySlice[] = [];
  let totalBytes = 0;
  for (const sourceId of [...selectedSources].sort()) {
    const document = documents.get(sourceId);
    if (document === undefined) continue;
    const sourceUnits = [...selectedUnits.values()].filter(
      (unit) => unit.sourceId === sourceId
    );
    for (const slice of mergeUnits(document, sourceUnits)) {
      if (totalBytes + slice.bytes.length > input.rules.maxBytes) {
        warnings.push(`Byte bound omitted ${document.path}`);
        continue;
      }
      slices.push(slice);
      totalBytes += slice.bytes.length;
    }
  }
  return success({
    roots: input.roots,
    rules: input.rules,
    slices,
    edges: semantic.value.filter(
      (edge) =>
        selectedSources.has(edge.fromSourceId) &&
        selectedSources.has(edge.toSourceId)
    ),
    omittedSourceIds: input.documents
      .filter((document) => !selectedSources.has(document.sourceId))
      .map((document) => document.sourceId)
      .sort(),
    totalBytes,
    warnings,
    producers: [
      treeSitterJsTsStructureProvider.metadata,
      typeScriptSemanticEdgeProvider.metadata,
      conservativeFileStructureProvider.metadata
    ]
  });
}

