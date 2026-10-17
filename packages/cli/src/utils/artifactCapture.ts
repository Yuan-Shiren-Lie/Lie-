import { beginArtifactCapture } from "@hyperframes/studio-server/history";
import { withOwner } from "./historyOwner.js";

/** Never waits for history another process holds: recording an artifact must not hold up the command making it. */
export async function captureArtifactRevision(projectDir: string) {
  return withOwner(
    projectDir,
    async (owner) => {
      await owner.checkpoint();
      return beginArtifactCapture(projectDir);
    },
    { ownerWaitMs: 0 },
  );
}
