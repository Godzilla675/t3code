import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { Thread } from "../types";

export function useTurnDiffSummaries(activeThread: Thread | undefined) {
  const turnDiffSummaries = activeThread?.turnDiffSummaries ?? [];

  const inferredCheckpointTurnCountByTurnId = inferCheckpointTurnCountByTurnId(turnDiffSummaries);

  return { turnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
