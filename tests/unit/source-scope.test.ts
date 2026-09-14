import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  DeliveryRules,
  SourceDocument,
  SourceLanguage
} from "../../src/contracts/source-scope.js";
import { sha256Base64Url } from "../../src/core/hash.js";
import { buildDeliveryPlan } from "../../src/source/delivery.js";
import {
  conservativeFileStructureProvider,
  treeSitterJsTsStructureProvider
} from "../../src/source/tree-sitter.js";
import { typeScriptSemanticEdgeProvider } from "../../src/source/typescript-semantic.js";

function document(
  sourceId: string,
  path: string,
  text: string,
  language: SourceLanguage = "typescript"
): SourceDocument {
  const bytes = Buffer.from(text, "utf8");
  return {
    sourceId,
    path: resolve(path),
    language,
    bytes,
    identity: {
      sha256: sha256Base64Url(bytes),
      byteLength: bytes.length
    }
  };
}

const fullRules: DeliveryRules = {
  maxFiles: 8,
  maxBytes: 64 * 1024,
  maxDepth: 3,
  includeImports: true,
  includeDefinitions: true,
  includeTypes: true,
  includeTests: true
};

describe("CQ-05 JS/TS source scope", () => {
  it("uses Tree-sitter byte ranges for exact Unicode slices", () => {
    const source = document(
      "unicode",
      "virtual/unicode.ts",
      'const emoji = "😀";\nexport function target(value: string) {\n  return `${emoji}:${value}`;\n}\n'
    );
    const units = treeSitterJsTsStructureProvider.units({
      document: source
    });
    expect(units.ok).toBe(true);
    if (!units.ok) return;
    const target = units.value.find(
      (unit) => unit.kind === "function" && unit.name === "target"
    );
    expect(target).toBeDefined();
    if (target === undefined) return;
    const exact = source.bytes.subarray(target.startByte, target.endByte);
    expect(sha256Base64Url(exact)).toBe(target.sha256);
    expect(exact.toString("utf8")).toContain("function target");
    expect(target.startByte).toBe(source.bytes.indexOf("function"));
  });

  it("creates TypeScript import/type/test edges across provided files only", () => {
    const documents = [
      document(
        "entry",
        "virtual/entry.ts",
        'import type { Config } from "./config";\nexport function run(config: Config) { return config.enabled; }\n'
      ),
      document(
        "config",
        "virtual/config.ts",
        "export interface Config { enabled: boolean }\n"
      ),
      document(
        "test",
        "virtual/entry.test.ts",
        'import { run } from "./entry";\ntest("run", () => run({ enabled: true }));\n'
      )
    ];
    const edges = typeScriptSemanticEdgeProvider.edges({ documents });
    expect(edges.ok).toBe(true);
    if (!edges.ok) return;
    expect(
      edges.value.some(
        (edge) =>
          edge.kind === "import" &&
          edge.fromSourceId === "entry" &&
          edge.toSourceId === "config"
      )
    ).toBe(true);
    expect(
      edges.value.some(
        (edge) =>
          edge.kind === "test" &&
          edge.fromSourceId === "test" &&
          edge.toSourceId === "entry"
      )
    ).toBe(true);
  });

  it("builds bounded delivery closure and omits unrelated source", () => {
    const documents = [
      document(
        "entry",
        "virtual/entry.ts",
        'import type { Config } from "./config";\nexport function run(config: Config) { return config.enabled; }\n'
      ),
      document(
        "config",
        "virtual/config.ts",
        "export interface Config { enabled: boolean }\n"
      ),
      document(
        "test",
        "virtual/entry.test.ts",
        'import { run } from "./entry";\ntest("run", () => run({ enabled: true }));\n'
      ),
      document(
        "unrelated",
        "virtual/unrelated.ts",
        "export const unrelated = 123;\n"
      )
    ];
    const plan = buildDeliveryPlan({
      documents,
      roots: [{ sourceId: "entry", symbol: "run" }],
      rules: fullRules
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(new Set(plan.value.slices.map((slice) => slice.sourceId))).toEqual(
      new Set(["entry", "config", "test"])
    );
    expect(plan.value.omittedSourceIds).toContain("unrelated");
    expect(
      plan.value.slices.every((slice) =>
        sha256Base64Url(slice.bytes).startsWith(slice.sha256)
      )
    ).toBe(true);
    expect(plan.value.totalBytes).toBeLessThanOrEqual(fullRules.maxBytes);
  });

  it("uses an explicit exact whole-file fallback for other languages", () => {
    const source = document(
      "python",
      "virtual/tool.py",
      "def run():\n    return 1\n",
      "other"
    );
    const units = conservativeFileStructureProvider.units({
      document: source
    });
    expect(units.ok).toBe(true);
    if (!units.ok) return;
    expect(units.value).toHaveLength(1);
    expect(
      source.bytes
        .subarray(units.value[0]?.startByte, units.value[0]?.endByte)
        .equals(source.bytes)
    ).toBe(true);
  });
});
