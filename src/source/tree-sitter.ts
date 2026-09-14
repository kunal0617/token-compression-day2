import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScriptLanguages from "tree-sitter-typescript";

import type {
  CodeStructureProvider,
  ProducerMetadata
} from "../contracts/providers.js";
import type {
  CodeUnit,
  CodeUnitKind,
  SourceStructureRequest
} from "../contracts/source-scope.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { deterministicUuid, sha256Base64Url } from "../core/hash.js";
import { success, type Result } from "../core/result.js";

const unitKinds: Readonly<Record<string, CodeUnitKind>> = {
  import_statement: "import",
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  lexical_declaration: "variable",
  variable_declaration: "variable",
  method_definition: "method",
  export_statement: "export"
};

function producer(
  producerId: string,
  version: string,
  contract: unknown
): ProducerMetadata {
  return {
    producerId,
    kind: "code-structure",
    version,
    digest: canonicalJsonDigest({ producerId, version, contract })
  };
}

function parserFor(
  language: SourceStructureRequest["document"]["language"]
): Parser | undefined {
  const parser = new Parser();
  if (language === "typescript") {
    parser.setLanguage(TypeScriptLanguages.typescript);
  } else if (language === "tsx") {
    parser.setLanguage(TypeScriptLanguages.tsx);
  } else if (language === "javascript" || language === "jsx") {
    parser.setLanguage(JavaScript);
  } else {
    return undefined;
  }
  return parser;
}

function nodeName(node: Parser.SyntaxNode): string | undefined {
  return (
    node.childForFieldName("name")?.text ??
    node.namedChildren.find((child) => child.type === "identifier")?.text
  );
}

function byteOffset(text: string, characterOffset: number): number {
  return Buffer.byteLength(text.slice(0, characterOffset), "utf8");
}

export class TreeSitterJsTsStructureProvider
  implements CodeStructureProvider<SourceStructureRequest, CodeUnit>
{
  readonly metadata = producer(
    "builtin.cq05.tree-sitter-js-ts",
    "1.0.0",
    ["typescript", "tsx", "javascript", "jsx", "byte-ranges"]
  );

  units(request: SourceStructureRequest): Result<readonly CodeUnit[]> {
    const parser = parserFor(request.document.language);
    if (parser === undefined) return success([]);
    const text = request.document.bytes.toString("utf8");
    const tree = parser.parse(text);
    const units: CodeUnit[] = [];
    const visit = (node: Parser.SyntaxNode): void => {
      const kind =
        unitKinds[node.type] ??
        (node.type === "call_expression" &&
        /^(?:it|test|describe)\s*\(/.test(node.text)
          ? "test"
          : undefined);
      if (kind !== undefined && node.endIndex > node.startIndex) {
        const startByte = byteOffset(text, node.startIndex);
        const endByte = byteOffset(text, node.endIndex);
        const bytes = request.document.bytes.subarray(
          startByte,
          endByte
        );
        const name = nodeName(node);
        units.push({
          unitId: deterministicUuid(
            `${request.document.sourceId}:${kind}:${startByte}:${endByte}:${name ?? ""}`
          ),
          sourceId: request.document.sourceId,
          kind,
          ...(name === undefined ? {} : { name }),
          startByte,
          endByte,
          sha256: sha256Base64Url(bytes),
          producer: this.metadata
        });
      }
      for (const child of node.namedChildren) visit(child);
    };
    visit(tree.rootNode);
    return success(
      units.sort(
        (left, right) =>
          left.startByte - right.startByte ||
          left.endByte - right.endByte ||
          left.unitId.localeCompare(right.unitId)
      )
    );
  }
}

export class ConservativeFileStructureProvider
  implements CodeStructureProvider<SourceStructureRequest, CodeUnit>
{
  readonly metadata = producer(
    "builtin.cq05.conservative-file-fallback",
    "1.0.0",
    ["exact-whole-file", "unknown-language"]
  );

  units(request: SourceStructureRequest): Result<readonly CodeUnit[]> {
    if (request.document.bytes.length === 0) return success([]);
    return success([
      {
        unitId: deterministicUuid(`${request.document.sourceId}:file`),
        sourceId: request.document.sourceId,
        kind: "file",
        startByte: 0,
        endByte: request.document.bytes.length,
        sha256: sha256Base64Url(request.document.bytes),
        producer: this.metadata
      }
    ]);
  }
}

export const treeSitterJsTsStructureProvider =
  new TreeSitterJsTsStructureProvider();
export const conservativeFileStructureProvider =
  new ConservativeFileStructureProvider();
