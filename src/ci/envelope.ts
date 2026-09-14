import type { ArtifactSnapshot } from "../contracts/types.js";
import { splitRawLines, type LineRecord } from "../segment/segment.js";

const ISO_ENVELOPE =
  /^(?:\uFEFF|\u00ef\u00bb\u00bf)?(?<timestamp>\d{4}-\d{2}-\d{2}T[0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?Z)\s(?<content>[\s\S]*)$/;
const ANSI_SGR = /\u001b\[[0-9;]*m/g;
const COPIED_ANSI_WRAPPER =
  /^\[(?:[1-9]\d{0,2})(?:;(?:0|[1-9]\d{0,2})){0,7}m(?<body>[\s\S]*)\[0m$/;

export interface CiLineAnalysis {
  readonly line: LineRecord;
  readonly recognizedEnvelope: boolean;
  readonly timestamp?: string;
  readonly content: string;
  readonly stableSignature: string;
  readonly hadAnsi: boolean;
  readonly hadRealAnsi: boolean;
  readonly hadCopiedAnsi: boolean;
  readonly directive: "group" | "endgroup" | "none";
  readonly groupTitle?: string;
}

function withoutLineEnding(value: string): string {
  return value.replace(/(?:\r\n|\r|\n)$/u, "");
}

export function stripAnsiSgr(value: string): string {
  return value.replace(ANSI_SGR, "");
}

function analyzeCiEnvelopeSgr(value: string): {
  readonly content: string;
  readonly hadRealAnsi: boolean;
  readonly hadCopiedAnsi: boolean;
} {
  const withoutRealAnsi = stripAnsiSgr(value);
  const copied = COPIED_ANSI_WRAPPER.exec(withoutRealAnsi);
  return {
    content: copied?.groups?.body ?? withoutRealAnsi,
    hadRealAnsi: withoutRealAnsi !== value,
    hadCopiedAnsi: copied !== null
  };
}

export function normalizeCiStableContent(value: string): string {
  return stripAnsiSgr(value)
    .replace(/\bworker[-_ ]?\d+\b/gi, "<worker>")
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|m|min|minutes)\b/gi,
      "<duration>"
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "<uuid>"
    );
}

export function analyzeCiLines(
  artifact: ArtifactSnapshot
): readonly CiLineAnalysis[] {
  return splitRawLines(artifact.bytes).map((line) => {
    const rawBody = withoutLineEnding(line.text);
    const envelope = ISO_ENVELOPE.exec(rawBody);
    const contentWithAnsi = envelope?.groups?.content ?? rawBody.replace(/^\uFEFF/u, "");
    const sgr =
      envelope === null
        ? {
            content: stripAnsiSgr(contentWithAnsi),
            hadRealAnsi: stripAnsiSgr(contentWithAnsi) !== contentWithAnsi,
            hadCopiedAnsi: false
          }
        : analyzeCiEnvelopeSgr(contentWithAnsi);
    const content = sgr.content;
    const group = /^(?:##\[group\]|::group::)(.*)$/i.exec(content);
    const endGroup = /^(?:##\[endgroup\]|::endgroup::)\s*$/i.test(content);
    return {
      line,
      recognizedEnvelope: envelope !== null,
      ...(envelope?.groups?.timestamp === undefined
        ? {}
        : { timestamp: envelope.groups.timestamp }),
      content,
      stableSignature: normalizeCiStableContent(content),
      hadAnsi: sgr.hadRealAnsi || sgr.hadCopiedAnsi,
      hadRealAnsi: sgr.hadRealAnsi,
      hadCopiedAnsi: sgr.hadCopiedAnsi,
      directive: group !== null ? "group" : endGroup ? "endgroup" : "none",
      ...(group?.[1] === undefined ? {} : { groupTitle: group[1].trim() })
    };
  });
}

export function isRecognizedCiArtifact(
  lines: readonly CiLineAnalysis[]
): boolean {
  if (lines.length === 0) return false;
  const envelopes = lines.filter((line) => line.recognizedEnvelope).length;
  const directives = lines.filter((line) => line.directive !== "none").length;
  return envelopes >= 3 && envelopes / lines.length >= 0.4 && directives >= 2;
}

export function isRoutineCiDeprecation(content: string): boolean {
  return (
    /\b(?:DeprecationWarning|is being deprecated|is deprecated)\b/i.test(
      content
    ) &&
    !/##\[warning\]|::warning\b/i.test(content) &&
    !/\b(?:failure|failed|fatal|panic)\b/i.test(content)
  );
}

export function isCiCriticalContent(content: string): boolean {
  if (isRoutineCiDeprecation(content)) return false;
  return (
    /##\[(?:error|warning)\]|::(?:error|warning)\b/i.test(content) ||
    /\b(?:AssertionError|[A-Za-z_$][\w.$]*(?:Error|Exception|Failure):|fatal:|panic:)\b/.test(
      content
    ) ||
    /"(?:conclusion|status)"\s*:\s*"(?:failure|failed|cancelled|timed_out|action_required|in_progress|completed)"/i.test(
      content
    ) ||
    /\b(?:script_conclusion|conclusion)\s*:\s*(?:failure|failed|cancelled|timed_out)\b/i.test(
      content
    ) ||
    /\b(?:state|status|conclusion)\s*[:=]\s*(?:failure|failed|cancelled|timed_out|action_required)\b/i.test(
      content
    ) ||
    /\berror\s*[:=]\s*\S/i.test(content) ||
    /"(?:id|run_id|workflow_name|head_branch|head_sha|name)"\s*:/i.test(
      content
    ) ||
    /\b(?:id|job_id|run_id|trace_id|request_id)\s*[:=]\s*\S/i.test(
      content
    ) ||
    /\b(?:Complete job name|Set up job|source-branch|image-name|Image|run-id|runid|run-count|runcount|branch|workflow|commit|repository|ref|pattern|path)\s*:/i.test(
      content
    ) ||
    /\b(?:Found|Total of)\s+0\s+artifact\(s\)|\b0\s+artifact\(s\)\s+downloaded/i.test(
      content
    ) ||
    /\b(?:success_percent|success-percent|failed_count|jobs_failed|jobs-executed|jobs_executed|metrics result)\s*[:=]/i.test(
      content
    ) ||
    /^\s*name:\s*".*\b(?:workflow_success_percent|jobs_executed|jobs_failed|jobs_skipped)\b/i.test(
      content
    )
  );
}

export function isCiCriticalLine(analysis: CiLineAnalysis): boolean {
  if (
    analysis.hadRealAnsi &&
    !isCiActualDiagnosticContent(analysis.content) &&
    !/##\[(?:error|warning)\]|::(?:error|warning)\b/i.test(analysis.content)
  ) {
    return false;
  }
  return isCiCriticalContent(analysis.content);
}

export function isCiAlwaysMandatoryContent(content: string): boolean {
  return (
    /##\[(?:error|warning)\]|::(?:error|warning)\b/i.test(content) ||
    /\b(?:AssertionError|[A-Za-z_$][\w.$]*(?:Error|Exception|Failure):|fatal:|panic:)\b/.test(
      content
    ) ||
    /"(?:conclusion|status)"\s*:\s*"(?:failure|failed|cancelled|timed_out|action_required)"/i.test(
      content
    ) ||
    /\b(?:script_conclusion|conclusion)\s*:\s*(?:failure|failed|cancelled|timed_out)\b/i.test(
      content
    ) ||
    /\b(?:Found|Total of)\s+0\s+artifact\(s\)|\b0\s+artifact\(s\)\s+downloaded/i.test(
      content
    ) ||
    /\b(?:success_percent|success-percent|failed_count|jobs_failed|metrics result)\s*:\s*(?:0|[1-9]\d*)\b/i.test(
      content
    ) ||
    /^\s*name:\s*".*\b(?:workflow_success_percent|jobs_executed|jobs_failed|jobs_skipped)\b/i.test(
      content
    )
  );
}

export function ciCriticalOrdinalsToKeep(
  lines: readonly CiLineAnalysis[]
): ReadonlySet<number> {
  const kept = new Set<number>();
  const repeated = new Map<string, CiLineAnalysis[]>();
  for (const line of lines) {
    if (!isCiCriticalLine(line)) continue;
    if (isCiAlwaysMandatoryContent(line.content)) {
      kept.add(line.line.ordinal);
      continue;
    }
    const occurrences = repeated.get(line.stableSignature) ?? [];
    occurrences.push(line);
    repeated.set(line.stableSignature, occurrences);
  }
  for (const occurrences of repeated.values()) {
    const first = occurrences[0];
    const last = occurrences.at(-1);
    if (first !== undefined) kept.add(first.line.ordinal);
    if (last !== undefined) kept.add(last.line.ordinal);
  }
  return kept;
}

export function isCiRoutineWrapperContent(content: string): boolean {
  return /^(?:Prepare workflow directory|Prepare all required actions|Getting action download info|Download action repository|Post job cleanup|Temporarily overriding HOME|Adding repository directory|Evaluate and set job outputs|Set output |Cleaning up orphan processes|Working directory is|git version |hint:|Initialized empty Git repository|Updating files:|Syncing repository:)/i.test(
    content.trim()
  );
}

function isAllowedAnsiShellScaffolding(content: string): boolean {
  return (
    /^\s*(?:#.*|[(){}])\s*$/.test(content) ||
    /^\s*(?:if|then|elif|else|fi|for|while|do|done|case|esac)\b/.test(
      content
    ) ||
    /^\s*(?:JOBS_OUTPUT|JOBS_FILE|JOB_DATA|job_name|job_state|script_name|script_conclusion|total_count|success_count|failed_count|skipped_count|success_percent|conclusion_json)(?:=|\+=)/.test(
      content
    ) ||
    /^\s*(?:gh\s+api|jq\b|echo\b|exit\s+\d+\b|source\b|render_test_summary\b)/.test(
      content
    ) ||
    /^\s*(?:--[\w-]+|-H\s+"[^"]+")\s*\\$/.test(content) ||
    /^\s*(?:--[\w-]+|-H\b|["']\/?[\w$./?=&:{}*+-]+["']?(?:\s*[\\|])?|\/[\w$./*-]+(?:\s*\\)?)\s*$/.test(
      content
    )
  );
}

export function isAllowedCiGroupBodyLine(
  analysis: CiLineAnalysis,
  groupTitle: string
): boolean {
  const title = groupTitle.trim();
  const content = analysis.content.trim();
  if (content.length === 0 || isCiActualDiagnosticContent(content)) return false;

  if (/^Runner Image Provisioner$/i.test(title)) {
    return /^(?:Hosted Compute Agent|Version:\s*\S+|Build Date:\s*\S+|Worker ID:\s*\{?[0-9a-f-]+\}?|(?:Azure )?Region:\s*[\w.-]+)$/i.test(
      content
    );
  }
  if (/^Operating System$/i.test(title)) {
    return (
      /^(?:Ubuntu|Windows Server|macOS)\b/i.test(content) ||
      /^\d+(?:\.\d+){1,3}$/.test(content) ||
      /^LTS$/i.test(content)
    );
  }
  if (/^GITHUB_TOKEN Permissions$/i.test(title)) {
    return /^[A-Za-z][A-Za-z -]+:\s*(?:read|write|none)$/i.test(content);
  }
  if (/^Runner Image$/i.test(title)) {
    return /^(?:Version:\s*\S+|Included Software:\s*https?:\/\/\S+|Image Release:\s*https?:\/\/\S+)$/i.test(
      content
    );
  }
  if (
    /^(?:Getting Git version info|Initializing the repository|Disabling automatic garbage collection|Setting up auth|Fetching the repository|Determining the checkout info|Checking out the ref)$/i.test(
      title
    )
  ) {
    return (
      /^\[command\]\/usr\/bin\/git\b/i.test(content) ||
      /^(?:git version |hint:|Initialized empty Git repository|Updating files:|From https?:\/\/|Working directory is)/i.test(
        content
      ) ||
      /^\* \[new branch\]/i.test(content)
    );
  }
  if (/^(?:Jobs Output|Job Data\b)/i.test(title)) {
    return (
      /^[\s]*[\{\}\[\],]+$/.test(content) ||
      /^"(?:created_at|started_at|completed_at|node_id|url|html_url|check_run_url|labels|runner_id|runner_name|runner_group_id|runner_group_name|steps)"\s*:/i.test(
        content
      )
    );
  }
  if (/^Run\b/i.test(title)) {
    if (analysis.hadAnsi) {
      return isAllowedAnsiShellScaffolding(content);
    }
    return (
      /^(?:with:|env:|shell:|api-key:|metrics:|- type:|value:|host:|tags:|events:|service-checks:|api-url:|log-api-url:|logs:)/i.test(
        content
      ) ||
      /^-\s*"(?:repository|workflow|branch|commit|runid|runcount|deferred-compliance):/i.test(
        content
      ) ||
      /^(?:fetch-depth|token|ssh-strict|ssh-user|persist-credentials|clean|sparse-checkout-cone-mode|fetch-tags|show-progress|lfs|submodules|set-safe-directory|merge-multiple)\s*:/i.test(
        content
      )
    );
  }
  return false;
}

export function isCiActualDiagnosticContent(content: string): boolean {
  return (
    /##\[error\]|::error\b/i.test(content) ||
    /\b(?:AssertionError|[A-Za-z_$][\w.$]*(?:Error|Exception|Failure):|fatal:|panic:)\b/.test(
      content
    ) ||
    /\b(?:command|process|step|job)\b.{0,80}\b(?:failed|failure)\b/i.test(
      content
    ) ||
    /\b(?:state|status|conclusion)\s*[:=]\s*(?:failure|failed|cancelled|timed_out|action_required)\b/i.test(
      content
    ) ||
    /\berror\s*[:=]\s*\S/i.test(content)
  );
}

export function detectMissingCiFailureEvidence(
  artifact: ArtifactSnapshot
): string | undefined {
  const lines = analyzeCiLines(artifact);
  if (!isRecognizedCiArtifact(lines)) return undefined;
  const content = lines.map((line) => line.content).join("\n");
  const failedJob =
    /"conclusion"\s*:\s*"failure"[\s\S]{0,500}?"name"\s*:\s*"([^"]+)"/i.exec(
      content
    )?.[1] ??
    /"name"\s*:\s*"([^"]+)"[\s\S]{0,500}?"conclusion"\s*:\s*"failure"/i.exec(
      content
    )?.[1];
  const failedStep =
    /"steps"\s*:\s*\[[\s\S]{0,160}?"name"\s*:\s*"([^"]+)"[\s\S]{0,160}?"conclusion"\s*:\s*"failure"/i.exec(
      content
    )?.[1];
  if (
    failedJob === undefined ||
    /##\[error\]|::error\b|(?:AssertionError|[A-Za-z_$][\w.$]*(?:Error|Exception|Failure):)/.test(
      content
    )
  ) {
    return undefined;
  }
  return `CI summary reports failed job "${failedJob}"${
    failedStep === undefined ? "" : ` during "${failedStep}"`
  }, but this artifact does not contain the detailed failing job log; root-cause evidence is missing.`;
}
