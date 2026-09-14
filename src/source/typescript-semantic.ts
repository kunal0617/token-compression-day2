import ts from "typescript";
import { dirname, extname, normalize, resolve } from "node:path";

import type {
  ProducerMetadata,
  SemanticEdgeProvider
} from "../contracts/providers.js";
import type {
  SemanticEdge,
  SemanticEdgeRequest,
  SourceDocument
} from "../contracts/source-scope.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { deterministicUuid } from "../core/hash.js";
import { success, type Result } from "../core/result.js";

function producer(): ProducerMetadata {
  const producerId = "builtin.cq05.typescript-semantic-edges";
  const version = "1.0.0";
  return {
    producerId,
    kind: "semantic-edge",
    version,
    digest: canonicalJsonDigest({
      producerId,
      version,
      contract: ["import", "definition", "type", "test", "provided-files-only"]
    })
  };
}

function byteOffset(text: string, characterOffset: number): number {
  return Buffer.byteLength(text.slice(0, characterOffset), "utf8");
}

function documentMap(
  documents: readonly SourceDocument[]
): ReadonlyMap<string, SourceDocument> {
  return new Map(
    documents.map((document) => [normalize(resolve(document.path)), document])
  );
}

function resolveImport(
  fromPath: string,
  specifier: string,
  documents: ReadonlyMap<string, SourceDocument>
): SourceDocument | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromPath), specifier);
  for (const candidate of [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map(
      (extension) => `${base}${extension}`
    ),
    ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((file) =>
      resolve(base, file)
    )
  ]) {
    const found = documents.get(normalize(candidate));
    if (found !== undefined) return found;
  }
  return undefined;
}

export class TypeScriptSemanticEdgeProvider
  implements SemanticEdgeProvider<SemanticEdgeRequest, SemanticEdge>
{
  readonly metadata = producer();

  edges(request: SemanticEdgeRequest): Result<readonly SemanticEdge[]> {
    const documents = documentMap(request.documents);
    const sourceTexts = new Map(
      [...documents.entries()].map(([path, document]) => [
        path,
        document.bytes.toString("utf8")
      ])
    );
    const options: ts.CompilerOptions = {
      allowJs: true,
      checkJs: false,
      noLib: true,
      noResolve: false,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext
    };
    const defaultHost = ts.createCompilerHost(options, true);
    const host: ts.CompilerHost = {
      ...defaultHost,
      fileExists: (path) => sourceTexts.has(normalize(resolve(path))),
      readFile: (path) => sourceTexts.get(normalize(resolve(path))),
      getSourceFile: (path, languageVersion) => {
        const absolute = normalize(resolve(path));
        const text = sourceTexts.get(absolute);
        return text === undefined
          ? undefined
          : ts.createSourceFile(
              absolute,
              text,
              languageVersion,
              true,
              extname(absolute).toLowerCase().includes("x")
                ? ts.ScriptKind.TSX
                : ts.ScriptKind.TS
            );
      },
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (path) => normalize(resolve(path)),
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      writeFile: () => undefined
    };
    const rootNames = [...documents.keys()];
    const program = ts.createProgram({ rootNames, options, host });
    const checker = program.getTypeChecker();
    const edges: SemanticEdge[] = [];

    for (const sourceFile of program.getSourceFiles()) {
      const fromDocument = documents.get(normalize(sourceFile.fileName));
      if (fromDocument === undefined) continue;
      const fromText = sourceTexts.get(normalize(sourceFile.fileName)) ?? "";
      for (const statement of sourceFile.statements) {
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          const target = resolveImport(
            sourceFile.fileName,
            statement.moduleSpecifier.text,
            documents
          );
          if (target !== undefined) {
            const start = byteOffset(fromText, statement.getStart(sourceFile));
            const end = byteOffset(fromText, statement.getEnd());
            edges.push({
              edgeId: deterministicUuid(
                `import:${fromDocument.sourceId}:${target.sourceId}:${start}:${end}`
              ),
              kind:
                /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(fromDocument.path)
                  ? "test"
                  : "import",
              fromSourceId: fromDocument.sourceId,
              fromStartByte: start,
              fromEndByte: end,
              toSourceId: target.sourceId,
              toStartByte: 0,
              toEndByte: target.bytes.length,
              symbol: statement.moduleSpecifier.text,
              producer: this.metadata
            });
          }
        }
      }
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          const symbol = checker.getSymbolAtLocation(node);
          const declaration = symbol?.declarations?.[0];
          if (declaration !== undefined) {
            const targetFile = declaration.getSourceFile();
            const targetDocument = documents.get(normalize(targetFile.fileName));
            if (
              targetDocument !== undefined &&
              (targetDocument.sourceId !== fromDocument.sourceId ||
                declaration.getStart(targetFile) !== node.getStart(sourceFile))
            ) {
              const targetText =
                sourceTexts.get(normalize(targetFile.fileName)) ?? "";
              const declarationKind =
                ts.isInterfaceDeclaration(declaration) ||
                ts.isTypeAliasDeclaration(declaration) ||
                ts.isClassDeclaration(declaration)
                  ? "type"
                  : "definition";
              edges.push({
                edgeId: deterministicUuid(
                  `${declarationKind}:${fromDocument.sourceId}:${node.getStart(
                    sourceFile
                  )}:${targetDocument.sourceId}:${declaration.getStart(
                    targetFile
                  )}:${node.text}`
                ),
                kind: declarationKind,
                fromSourceId: fromDocument.sourceId,
                fromStartByte: byteOffset(
                  fromText,
                  node.getStart(sourceFile)
                ),
                fromEndByte: byteOffset(fromText, node.getEnd()),
                toSourceId: targetDocument.sourceId,
                toStartByte: byteOffset(
                  targetText,
                  declaration.getStart(targetFile)
                ),
                toEndByte: byteOffset(targetText, declaration.getEnd()),
                symbol: node.text,
                producer: this.metadata
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return success(
      [...new Map(edges.map((edge) => [edge.edgeId, edge])).values()].sort(
        (left, right) => left.edgeId.localeCompare(right.edgeId)
      )
    );
  }
}

export const typeScriptSemanticEdgeProvider =
  new TypeScriptSemanticEdgeProvider();

