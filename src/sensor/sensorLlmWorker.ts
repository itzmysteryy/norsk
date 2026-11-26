import {
  env,
  pipeline,
  type TextGenerationPipeline,
} from '@huggingface/transformers';
import type { AiCorrection, AiSensorCritique, CefrLevel } from '../types/sensor.ts';

export const SENSOR_LLM_MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';

export type LlmWorkerRequest =
  | { readonly type: 'init' }
  | {
      readonly type: 'critique';
      readonly id: number;
      readonly level: CefrLevel;
      readonly promptNb: string;
      readonly transcript: string;
      readonly durationSeconds: number;
    };

export type LlmWorkerResponse =
  | {
      readonly type: 'progress';
      readonly file: string;
      readonly progress: number | null;
      readonly status: string;
    }
  | {
      readonly type: 'ready';
      readonly modelId: string;
      readonly device: 'webgpu' | 'wasm';
    }
  | {
      readonly type: 'result';
      readonly id: number;
      readonly critique: AiSensorCritique;
    }
  | {
      readonly type: 'error';
      readonly id?: number;
      readonly message: string;
    };

interface WorkerScope {
  postMessage: (message: LlmWorkerResponse) => void;
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<LlmWorkerRequest>) => void,
  ) => void;
}

const workerScope = globalThis as unknown as WorkerScope;

env.allowLocalModels = false;

let generatorPromise: Promise<TextGenerationPipeline> | null = null;
let activeDevice: 'webgpu' | 'wasm' = 'wasm';

async function detectLlmDeviceAndDtype(): Promise<{
  readonly device: 'webgpu' | 'wasm';
  readonly dtype: 'q4f16' | 'q4' | 'q8';
}> {
  const nav = navigator as Navigator & {
    gpu?: {
      requestAdapter: () => Promise<{ features?: { has: (feature: string) => boolean } } | null>;
    };
  };

  if (nav.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter();
      if (adapter) {
        const fp16 = Boolean(adapter.features?.has('shader-f16'));
        return {
          device: 'webgpu',
          dtype: fp16 ? 'q4f16' : 'q4',
        };
      }
    } catch {
      // Fall back to WASM when WebGPU is unavailable.
    }
  }

  return {
    device: 'wasm',
    dtype: 'q8',
  };
}

function getGenerator(): Promise<TextGenerationPipeline> {
  if (generatorPromise) {
    return generatorPromise;
  }

  generatorPromise = (async () => {
    const { device, dtype } = await detectLlmDeviceAndDtype();
    activeDevice = device;

    const gen = await pipeline('text-generation', SENSOR_LLM_MODEL_ID, {
      device,
      dtype,
      progress_callback: (info) => {
        const file = 'file' in info && typeof info.file === 'string' ? info.file : '';
        const progress =
          'progress' in info && typeof info.progress === 'number' ? info.progress : null;
        workerScope.postMessage({
          type: 'progress',
          status: info.status,
          file,
          progress,
        });
      },
    });

    workerScope.postMessage({
      type: 'ready',
      modelId: SENSOR_LLM_MODEL_ID,
      device: activeDevice,
    });

    return gen;
  })().catch((err: unknown) => {
    generatorPromise = null;
    throw err;
  });

  return generatorPromise;
}

function parseCritiqueResponse(rawText: string): AiSensorCritique {
  const trimmed = rawText.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');

  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
        examinerComment?: unknown;
        corrections?: unknown;
        followUpNb?: unknown;
      };

      const examinerComment =
        typeof parsed.examinerComment === 'string' && parsed.examinerComment.trim()
          ? parsed.examinerComment.trim()
          : 'Response evaluated.';

      const rawCorrections = Array.isArray(parsed.corrections) ? parsed.corrections : [];
      const corrections: AiCorrection[] = rawCorrections
        .filter(
          (item): item is { original: string; corrected: string; note?: string } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { original?: unknown }).original === 'string' &&
            typeof (item as { corrected?: unknown }).corrected === 'string',
        )
        .slice(0, 3)
        .map((item) => ({
          original: item.original.trim(),
          corrected: item.corrected.trim(),
          note: typeof item.note === 'string' ? item.note.trim() : 'Grammar / phrasing suggestion',
        }))
        .filter((item) => item.original.length > 0 && item.corrected.length > 0);

      const followUpNb =
        typeof parsed.followUpNb === 'string' && parsed.followUpNb.trim()
          ? parsed.followUpNb.trim()
          : '';

      return {
        examinerComment,
        corrections,
        followUpNb,
        device: activeDevice,
      };
    } catch {
      // Fall through to plain-text critique.
    }
  }

  return {
    examinerComment: trimmed || 'Local AI Sensor completed review.',
    corrections: [],
    followUpNb: '',
    device: activeDevice,
  };
}

workerScope.addEventListener('message', (event: MessageEvent<LlmWorkerRequest>) => {
  const message = event.data;

  if (message.type === 'init') {
    void getGenerator().catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : 'Failed to initialize AI Sensor model.';
      workerScope.postMessage({ type: 'error', message: detail });
    });
    return;
  }

  if (message.type === 'critique') {
    void (async () => {
      try {
        const generator = await getGenerator();

        const messages = [
          {
            role: 'system' as const,
            content:
              'Du er en vennlig norsk sensor. Svar KUN med gyldig JSON på enkelt norsk bokmål: {"examinerComment":"kort vurdering på norsk","corrections":[{"original":"...","corrected":"...","note":"kort forklaring på norsk"}],"followUpNb":"ett oppfølgingsspørsmål på norsk"}.',
          },
          {
            role: 'user' as const,
            content: `Nivå: ${message.level}\nTid: ${message.durationSeconds}s\nOppgave: ${message.promptNb}\nSvar: "${message.transcript}"\nSvar kun med JSON på norsk.`,
          },
        ];

        const output = await generator(messages, {
          max_new_tokens: 240,
          do_sample: false,
          return_full_text: false,
        });

        const first = Array.isArray(output) ? output[0] : output;
        let rawContent = '';
        if (first && typeof first === 'object' && 'generated_text' in first) {
          const generated = first.generated_text;
          if (typeof generated === 'string') {
            rawContent = generated;
          } else if (Array.isArray(generated)) {
            const lastMsg = generated.at(-1);
            if (lastMsg && typeof lastMsg === 'object' && 'content' in lastMsg && typeof lastMsg.content === 'string') {
              rawContent = lastMsg.content;
            }
          }
        }

        const critique = parseCritiqueResponse(rawContent);
        workerScope.postMessage({
          type: 'result',
          id: message.id,
          critique,
        });
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : 'AI Sensor evaluation failed.';
        workerScope.postMessage({
          type: 'error',
          id: message.id,
          message: detail,
        });
      }
    })();
  }
});
