import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
} from '@huggingface/transformers';

export const WHISPER_MODEL_ID = 'onnx-community/nb-whisper-base-ONNX';

export type WorkerRequest =
  | { readonly type: 'init' }
  | { readonly type: 'transcribe'; readonly id: number; readonly audio: Float32Array };

export type WorkerResponse =
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
      readonly transcript: string;
    }
  | {
      readonly type: 'error';
      readonly id?: number;
      readonly message: string;
    };

interface WorkerScope {
  postMessage: (message: WorkerResponse) => void;
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ) => void;
}

const workerScope = globalThis as unknown as WorkerScope;

env.allowLocalModels = false;

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let activeDevice: 'webgpu' | 'wasm' = 'wasm';

async function detectDeviceAndDtype(): Promise<{
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
      // Fall back to WASM when WebGPU adapter negotiation fails.
    }
  }

  return {
    device: 'wasm',
    dtype: 'q8',
  };
}

function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (transcriberPromise) {
    return transcriberPromise;
  }

  transcriberPromise = (async () => {
    const { device, dtype } = await detectDeviceAndDtype();
    activeDevice = device;

    const asr = await pipeline('automatic-speech-recognition', WHISPER_MODEL_ID, {
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
      modelId: WHISPER_MODEL_ID,
      device: activeDevice,
    });

    return asr;
  })().catch((err: unknown) => {
    transcriberPromise = null;
    throw err;
  });

  return transcriberPromise;
}

workerScope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === 'init') {
    void getTranscriber().catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : 'Failed to initialize Whisper model.';
      workerScope.postMessage({ type: 'error', message: detail });
    });
    return;
  }

  if (message.type === 'transcribe') {
    void (async () => {
      try {
        const transcriber = await getTranscriber();
        const output = await transcriber(message.audio, {
          language: 'norwegian',
          task: 'transcribe',
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: true,
        });
        const text = Array.isArray(output) ? (output[0]?.text ?? '') : output.text;
        workerScope.postMessage({
          type: 'result',
          id: message.id,
          transcript: text.trim(),
        });
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : 'Local Whisper transcription failed.';
        workerScope.postMessage({
          type: 'error',
          id: message.id,
          message: detail,
        });
      }
    })();
  }
});
