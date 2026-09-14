import type {
  ArtifactClassification,
  ArtifactSnapshot,
  IntentClassification,
  IntentKind,
  RunOutcome
} from "../contracts/types.js";

function includesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifyArtifact(
  artifact: ArtifactSnapshot
): ArtifactClassification {
  if (artifact.role === "prompt") {
    return {
      artifactId: artifact.artifactId,
      kind: "prompt",
      confidence: 1,
      uncertain: false,
      reasons: ["Artifact role is the mandatory user prompt"]
    };
  }

  const text = artifact.bytes.toString("utf8");
  const reasons: string[] = [];
  let kind: ArtifactClassification["kind"] = "text";
  let confidence = 0.55;

  if (
    includesAny(text, [
      /^\s*(?:FAIL|FAILED|not ok)\b/im,
      /\b(?:tests?|suites?)\s+(?:failed|passed)\b/i,
      /\bExpected\b[\s\S]{0,200}\bReceived\b/i
    ])
  ) {
    kind = "test-log";
    confidence = 0.92;
    reasons.push("Test runner failure, assertion, or summary markers detected");
  } else if (
    includesAny(text, [
      /(?:^|\n).+:\d+:\d+:\s*(?:error|warning)\b/i,
      /\berror TS\d+\b/i,
      /\b(?:compiler|compilation)\s+(?:failed|error)\b/i
    ])
  ) {
    kind = "compiler-diagnostics";
    confidence = 0.9;
    reasons.push("Compiler diagnostic locations or codes detected");
  } else if (
    includesAny(text, [
      /(?:^|\n)\s*at\s+.+\(.+:\d+:\d+\)/,
      /\b(?:Error|Exception|Failure):\s+\S/
    ])
  ) {
    kind = "stack-trace";
    confidence = 0.88;
    reasons.push("Exception and stack-frame structure detected");
  } else if (
    includesAny(text, [
      /(?:^|\n)diff --git /,
      /(?:^|\n)@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/,
      /(?:^|\n)(?:---|\+\+\+) [ab]\//
    ])
  ) {
    kind = "diff";
    confidence = 0.96;
    reasons.push("Unified diff headers or hunks detected");
  } else if (
    includesAny(text, [
      /\b(?:INFO|WARN|ERROR|DEBUG)\b/,
      /\b(?:exit code|process exited)\b/i,
      /^\s*\[[0-9:.TZ+-]+\]/m
    ])
  ) {
    kind = "generic-log";
    confidence = 0.78;
    reasons.push("Log levels, timestamps, or process metadata detected");
  } else if (
    includesAny(text, [
      /\b(?:function|class|interface|const|let|var|import|package)\b/,
      /[{};]\s*(?:\r?\n|$)/
    ])
  ) {
    kind = "source";
    confidence = 0.67;
    reasons.push("Programming-language syntax detected");
  } else {
    reasons.push("No parser-specific artifact signature detected");
  }

  return {
    artifactId: artifact.artifactId,
    kind,
    confidence,
    uncertain: confidence < 0.75,
    reasons
  };
}

const intentRules: readonly {
  kind: IntentKind;
  pattern: RegExp;
  reason: string;
}[] = [
  {
    kind: "debug",
    pattern: /\b(debug|diagnose|root cause|why (?:does|did|is)|failure)\b/i,
    reason: "Debugging language detected"
  },
  {
    kind: "fix",
    pattern: /\b(fix|repair|resolve|implement)\b/i,
    reason: "Change or repair language detected"
  },
  {
    kind: "test",
    pattern: /\b(test|spec|vitest|jest|pytest)\b/i,
    reason: "Test-focused language detected"
  },
  {
    kind: "build",
    pattern: /\b(build|compile|typecheck|lint)\b/i,
    reason: "Build-focused language detected"
  },
  {
    kind: "review",
    pattern: /\b(review|audit|inspect|assess)\b/i,
    reason: "Review language detected"
  },
  {
    kind: "explain",
    pattern: /\b(explain|summarize|describe)\b/i,
    reason: "Explanation language detected"
  }
];

export function classifyIntent(prompt: ArtifactSnapshot): IntentClassification {
  const text = prompt.bytes.toString("utf8");
  for (const rule of intentRules) {
    if (rule.pattern.test(text)) {
      return {
        kind: rule.kind,
        confidence: 0.82,
        uncertain: false,
        reasons: [rule.reason]
      };
    }
  }
  return {
    kind: "general",
    confidence: 0.5,
    uncertain: true,
    reasons: ["No deterministic intent keyword matched"]
  };
}

export function determineOutcome(
  artifacts: readonly ArtifactSnapshot[]
): RunOutcome {
  const text = artifacts
    .filter((artifact) => artifact.role === "context")
    .map((artifact) => artifact.bytes.toString("utf8"))
    .join("\n");

  const exitCodes = [
    ...text.matchAll(
      /\b(?:exit code|process exited with code)\s*[:=]?\s*(-?\d+)\b/gi
    )
  ];
  const finalExit = exitCodes.at(-1)?.[1];
  if (finalExit !== undefined) {
    return Number(finalExit) === 0 ? "green" : "red";
  }

  if (
    /\b(?:tests?|suites?)\s+(?:failed|failing)\b/i.test(text) ||
    /\b(?:FAIL|FAILED)\b[\s\S]{0,120}\b(?:tests?|suites?)\b/i.test(text) ||
    /\bBuild failed\b/i.test(text)
  ) {
    return "red";
  }
  if (
    /\b(?:tests?|suites?)\s+passed\b/i.test(text) ||
    /\bBuild succeeded\b/i.test(text) ||
    /\bAll tests passed\b/i.test(text)
  ) {
    return "green";
  }

  const summaries = [
    ...text.matchAll(
      /(?:^|\n).{0,40}\b(?:summary|result|status)\b.{0,160}$/gim
    )
  ];
  const finalSummary = summaries.at(-1)?.[0] ?? "";
  if (/\b(?:failed|failure|error|red)\b/i.test(finalSummary)) return "red";
  if (/\b(?:passed|success|green|ok)\b/i.test(finalSummary)) return "green";
  return "unknown";
}

