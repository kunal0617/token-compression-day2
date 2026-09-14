import type {
  CodingAgentHandoffPort,
  HandoffReceipt,
  ValidatedContextPackage
} from "../contracts/types.js";
import { success, type Result } from "../core/result.js";
import { failure } from "../core/result.js";

export class OfflineHandoffPort implements CodingAgentHandoffPort {
  readonly acceptedRuns: string[] = [];

  async handoff(
    contextPackage: ValidatedContextPackage
  ): Promise<Result<HandoffReceipt>> {
    if (
      contextPackage.manifest.evidenceGate?.decision ===
      "gather-more-evidence"
    ) {
      return failure(
        "INVALID_ARGUMENT",
        "Gather More Evidence blocks coding-agent handoff"
      );
    }
    this.acceptedRuns.push(contextPackage.runId);
    return success({ accepted: true, runId: contextPackage.runId });
  }
}
