import type { AiEngineStatus, AiSensorCritique, CefrLevel } from '../types/sensor.ts';
import type { LlmWorkerRequest, LlmWorkerResponse } from './sensorLlmWorker.ts';

export interface SensorLlmClient {
  readonly enableAndWarmup: () => void;
  readonly critique: (input: {
    readonly level: CefrLevel;
    readonly promptNb: string;
    readonly transcript: string;
    readonly durationSeconds: number;
  }) => Promise<AiSensorCritique>;
  readonly getStatus: () => AiEngineStatus;
}

export async function detectWebGpuSupport(): Promise<boolean> {
  const nav = navigator as Navigator & {
    gpu?: { requestAdapter: () => Promise<unknown | null> };
  };
  if (!nav.gpu) {
    return false;
  }
  try {
    const adapter = await nav.gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

export function createSensorLlmClient(
  onStatusChange: (status: AiEngineStatus) => void,
): SensorLlmClient {
  const workerSupported = typeof Worker !== 'undefined';

  let worker: Worker | null = null;
  let status: AiEngineStatus = { phase: 'disabled' };
  let isModelReady = false;
  let nextJobId = 1;
  const fileProgress = new Map<string, number>();

  const pending = new Map<
    number,
    {
      readonly resolve: (critique: AiSensorCritique) => void;
      readonly reject: (err: Error) => void;
    }
  >();

  const setStatus = (next: AiEngineStatus): void => {
    status = next;
    onStatusChange(next);
  };

  const ensureWorker = (): Worker => {
    if (worker) {
      return worker;
    }
    if (!workerSupported) {
      throw new Error('Web Workers are unavailable in this browser.');
    }

    const created = new Worker(new URL('./sensorLlmWorker.ts', import.meta.url), {
      type: 'module',
    });

    created.addEventListener('message', (event: MessageEvent<LlmWorkerResponse>) => {
      const msg = event.data;

      if (msg.type === 'progress') {
        if (isModelReady) {
          return;
        }
        if (msg.file && msg.progress !== null) {
          fileProgress.set(msg.file, msg.progress);
        }
        let averageProgress: number | null = msg.progress;
        if (fileProgress.size > 0) {
          let sum = 0;
          for (const pct of fileProgress.values()) {
            sum += pct;
          }
          averageProgress = Math.round(sum / fileProgress.size);
        }
        setStatus({ phase: 'loading', progress: averageProgress });
        return;
      }

      if (msg.type === 'ready') {
        isModelReady = true;
        setStatus({ phase: 'ready', device: msg.device });
        return;
      }

      if (msg.type === 'result') {
        const job = pending.get(msg.id);
        if (job) {
          pending.delete(msg.id);
          if (
            status.phase === 'running' &&
            (msg.critique.device === 'webgpu' || msg.critique.device === 'wasm')
          ) {
            setStatus({ phase: 'ready', device: msg.critique.device });
          }
          job.resolve(msg.critique);
        }
        return;
      }

      if (msg.type === 'error') {
        if (msg.id !== undefined) {
          const job = pending.get(msg.id);
          if (job) {
            pending.delete(msg.id);
            setStatus({ phase: 'error', message: msg.message });
            job.reject(new Error(msg.message));
            return;
          }
        }
        setStatus({ phase: 'error', message: msg.message });
      }
    });

    created.addEventListener('error', (err: ErrorEvent) => {
      const message = err.message || 'AI Sensor Web Worker crashed.';
      setStatus({ phase: 'error', message });
      for (const job of pending.values()) {
        job.reject(new Error(message));
      }
      pending.clear();
    });

    worker = created;
    return created;
  };

  return {
    getStatus: () => status,

    enableAndWarmup: (): void => {
      try {
        const w = ensureWorker();
        if (status.phase === 'disabled' || status.phase === 'error') {
          setStatus({ phase: 'loading', progress: 0 });
        }
        const req: LlmWorkerRequest = { type: 'init' };
        w.postMessage(req);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unable to start AI Sensor worker.';
        setStatus({ phase: 'error', message });
      }
    },

    critique: (input): Promise<AiSensorCritique> => {
      const w = ensureWorker();
      const id = nextJobId++;
      if (isModelReady && status.phase === 'ready') {
        setStatus({ phase: 'running', device: status.device });
      }

      return new Promise<AiSensorCritique>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const req: LlmWorkerRequest = {
          type: 'critique',
          id,
          ...input,
        };
        w.postMessage(req);
      });
    },
  };
}
