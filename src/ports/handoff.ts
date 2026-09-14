import type {
  CodingAgentHandoffPort,
  HandoffReceipt,
  ValidatedContextPackage
} from "../contracts/types.js";
import { success, type Result } from "../core/result.js";

export class OfflineHandoffPort implements CodingAgentHandoffPort {
  readonly acceptedRuns: string[] = [];

  async handoff(
    contextPackage: ValidatedContextPackage
  ): Promise<Result<HandoffReceipt>> {
    this.acceptedRuns.push(contextPackage.runId);
    return success({ accepted: true, runId: contextPackage.runId });
  }
}

