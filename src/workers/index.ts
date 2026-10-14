import { OpenCodeWorker } from "./opencode.js";
import type { Worker } from "./types.js";

export type { Worker, WorkerResult } from "./types.js";
export { OpenCodeWorker, type FreeModel } from "./opencode.js";

export async function createWorker(opts: {
  id: string;
  workDir: string;
  model?: string;
  apiKey?: string;
}): Promise<Worker> {
  switch (opts.id) {
    case "opencode": {
      const worker = new OpenCodeWorker(opts.workDir, {
        model: opts.model,
        apiKey: opts.apiKey,
      });
      await worker.start();
      return worker;
    }
    default:
      throw new Error(`Unknown worker "${opts.id}". Supported: opencode`);
  }
}
