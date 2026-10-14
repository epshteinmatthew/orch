export interface WorkerResult {
  summary: string;
  rawText: string;
  diffSummary?: string;
}

export interface Worker {
  readonly id: string;
  run(
    prompt: string,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<WorkerResult>;
  dispose(): Promise<void>;
}
