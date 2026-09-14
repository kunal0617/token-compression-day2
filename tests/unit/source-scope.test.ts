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
        'import type { Config } from "./config.js";\nexport function run(config: Config) { return config.enabled; }\n'
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
        'import type { Config } from "./config.js";\nimport { unrelated } from "./unrelated";\nexport function run(config: Config) { return config.enabled; }\n'
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

  it("resolves aliases and re-exports through .js specifiers", () => {
    const documents = [
      document(
        "entry",
        "virtual/alias-entry.ts",
        'import { renamed } from "./barrel.js";\nexport const value = renamed();\n'
      ),
      document(
        "barrel",
        "virtual/barrel.ts",
        'export { original as renamed } from "./implementation.js";\n'
      ),
      document(
        "implementation",
        "virtual/implementation.ts",
        "export function original() { return 1; }\n"
      )
    ];
    const edges = typeScriptSemanticEdgeProvider.edges({ documents });
    expect(edges.ok).toBe(true);
    if (!edges.ok) return;
    expect(
      edges.value.some(
        (edge) =>
          edge.fromSourceId === "entry" &&
          edge.toSourceId === "barrel"
      )
    ).toBe(true);
    expect(
      edges.value.some(
        (edge) =>
          edge.fromSourceId === "barrel" &&
          edge.toSourceId === "implementation"
      )
    ).toBe(true);
  });

  it("includes every referenced declaration from one dependency file", () => {
    const documents = [
      document(
        "entry",
        "virtual/multi-entry.ts",
        'import { foo, type Config } from "./dep.js";\nexport function run(config: Config) { return foo(config); }\n'
      ),
      document(
        "dep",
        "virtual/dep.ts",
        [
          "export interface Config { enabled: boolean }",
          "export function foo(config: Config) { return config.enabled; }",
          "export const unrelated = 42;",
          ""
        ].join("\n")
      )
    ];
    const plan = buildDeliveryPlan({
      documents,
      roots: [{ sourceId: "entry", symbol: "run" }],
      rules: fullRules
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const dependency = Buffer.concat(
      plan.value.slices
        .filter((slice) => slice.sourceId === "dep")
        .map((slice) => slice.bytes)
    ).toString("utf8");
    expect(dependency).toContain("interface Config");
    expect(dependency).toContain("function foo");
    expect(dependency).not.toContain("unrelated");
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

  it("enforces maxFiles across explicit roots before semantic expansion", () => {
    const first = document(
      "first",
      "virtual/first.ts",
      "export const first = 1;\n"
    );
    const second = document(
      "second",
      "virtual/second.ts",
      "export const second = 2;\n"
    );
    const plan = buildDeliveryPlan({
      documents: [first, second],
      roots: [{ sourceId: "first" }, { sourceId: "second" }],
      rules: { ...fullRules, maxFiles: 1 }
    });
    expect(plan.ok).toBe(false);
  });

  it("validates document identity, copies slices, and fails roots over maxBytes", () => {
    const source = document(
      "identity",
      "virtual/identity.ts",
      "export function target() { return 1; }\n"
    );
    const invalid = {
      ...source,
      identity: { ...source.identity, sha256: "A".repeat(43) }
    };
    expect(
      buildDeliveryPlan({
        documents: [invalid],
        roots: [{ sourceId: "identity", symbol: "target" }],
        rules: fullRules
      }).ok
    ).toBe(false);
    expect(
      buildDeliveryPlan({
        documents: [source],
        roots: [{ sourceId: "identity", symbol: "target" }],
        rules: { ...fullRules, maxBytes: 4 }
      }).ok
    ).toBe(false);
    const plan = buildDeliveryPlan({
      documents: [source],
      roots: [{ sourceId: "identity", symbol: "target" }],
      rules: fullRules
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const before = Buffer.from(plan.value.slices[0]?.bytes ?? []);
    source.bytes.fill(0x78);
    expect(plan.value.slices[0]?.bytes.equals(before)).toBe(true);
  });
});
