import {
  formatMicrophoneError,
  hasAudioSignal,
  isMicrophoneSupported,
  startMicrophoneCapture,
  type AudioRecorderSession,
} from './audioCapture.ts';
import type { SpeechCaptureCallbacks, SpeechRecognizer } from './speechProvider.ts';
import type { WorkerRequest, WorkerResponse } from './whisperWorker.ts';

export type ModelStatus =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading'; readonly progress: number | null; readonly file: string }
  | { readonly phase: 'ready'; readonly modelId: string; readonly device: 'webgpu' | 'wasm' }
  | { readonly phase: 'error'; readonly message: string };

export interface LocalWhisperOptions {
  readonly onModelStatus?: (status: ModelStatus) => void;
}

export function createLocalWhisperRecognizer(
  options: LocalWhisperOptions = {},
): SpeechRecognizer & { readonly warmup: () => void; readonly cancel: () => void } {
  const workerSupported = typeof Worker !== 'undefined';
  const micSupported = isMicrophoneSupported();

  let worker: Worker | null = null;
  let activeRecorder: AudioRecorderSession | null = null;
  let activeCallbacks: SpeechCaptureCallbacks | null = null;
  let isCapturing = false;
  let stopRequestedBeforeReady = false;
  let nextJobId = 1;
  let activeJobId: number | null = null;
  let isModelReady = false;
  const fileProgress = new Map<string, number>();

  const emitModelStatus = (status: ModelStatus): void => {
    options.onModelStatus?.(status);
  };

  const ensureWorker = (): Worker => {
    if (worker) {
      return worker;
    }

    const created = new Worker(new URL('./whisperWorker.ts', import.meta.url), {
      type: 'module',
    });

    created.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
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
        emitModelStatus({
          phase: 'loading',
          progress: averageProgress,
          file: msg.file,
        });
        return;
      }

      if (msg.type === 'ready') {
        isModelReady = true;
        emitModelStatus({
          phase: 'ready',
          modelId: msg.modelId,
          device: msg.device,
        });
        return;
      }

      if (msg.type === 'result') {
        if (msg.id === activeJobId && activeCallbacks) {
          const cb = activeCallbacks;
          activeCallbacks = null;
          activeJobId = null;
          cb.onFinal(msg.transcript);
          cb.onEnd();
        }
        return;
      }

      if (msg.type === 'error') {
        if (msg.id !== undefined && msg.id === activeJobId && activeCallbacks) {
          const cb = activeCallbacks;
          activeCallbacks = null;
          activeJobId = null;
          cb.onError(msg.message);
          cb.onEnd();
        } else {
          emitModelStatus({ phase: 'error', message: msg.message });
        }
      }
    });

    created.addEventListener('error', (err: ErrorEvent) => {
      const message = err.message || 'Whisper Web Worker crashed.';
      emitModelStatus({ phase: 'error', message });
      if (activeCallbacks) {
        const cb = activeCallbacks;
        activeCallbacks = null;
        activeJobId = null;
        cb.onError(message);
        cb.onEnd();
      }
    });

    worker = created;
    return created;
  };

  const isSupported = (): boolean => workerSupported && micSupported;

  const unsupportedReason = (): string | null => {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return 'Mikrofon krever HTTPS eller localhost.';
    }
    if (!workerSupported) {
      return 'Nettleseren støtter ikke Web Workers.';
    }
    if (!micSupported) {
      return 'Mikrofonopptak er ikke tilgjengelig i denne nettleseren.';
    }
    return null;
  };

  const warmup = (): void => {
    if (!workerSupported) {
      return;
    }
    const w = ensureWorker();
    const initMsg: WorkerRequest = { type: 'init' };
    w.postMessage(initMsg);
  };

  const finishRecordingAndTranscribe = async (
    recorder: AudioRecorderSession,
    callbacks: SpeechCaptureCallbacks,
  ): Promise<void> => {
    try {
      callbacks.onProcessing?.();
      const audio = await recorder.stop();
      if (audio.length < 1600) {
        activeCallbacks = null;
        callbacks.onError('Opptaket var for kort. Hold knappen litt lenger mens du snakker.');
        callbacks.onEnd();
        return;
      }

      if (!hasAudioSignal(audio)) {
        activeCallbacks = null;
        callbacks.onError('Jeg hørte ingen lyd fra mikrofonen. Sjekk at mikrofonen er på.');
        callbacks.onEnd();
        return;
      }

      const w = ensureWorker();
      const jobId = nextJobId++;
      activeJobId = jobId;
      const req: WorkerRequest = {
        type: 'transcribe',
        id: jobId,
        audio,
      };
      w.postMessage(req, [audio.buffer]);
    } catch (err: unknown) {
      activeCallbacks = null;
      activeJobId = null;
      callbacks.onError(formatMicrophoneError(err));
      callbacks.onEnd();
    }
  };

  return {
    isSupported,
    unsupportedReason,
    warmup,

    start: (callbacks: SpeechCaptureCallbacks): boolean => {
      const reason = unsupportedReason();
      if (reason) {
        callbacks.onError(reason);
        callbacks.onEnd();
        return false;
      }

      if (isCapturing) {
        return false;
      }

      isCapturing = true;
      stopRequestedBeforeReady = false;
      activeCallbacks = callbacks;
      warmup();

      void startMicrophoneCapture()
        .then((session) => {
          if (stopRequestedBeforeReady) {
            isCapturing = false;
            return finishRecordingAndTranscribe(session, callbacks);
          }
          activeRecorder = session;
        })
        .catch((err: unknown) => {
          isCapturing = false;
          activeRecorder = null;
          activeCallbacks = null;
          callbacks.onError(formatMicrophoneError(err));
          callbacks.onEnd();
        });

      return true;
    },

    stop: (): void => {
      if (!isCapturing) {
        return;
      }

      if (!activeRecorder) {
        stopRequestedBeforeReady = true;
        return;
      }

      const recorder = activeRecorder;
      const callbacks = activeCallbacks;
      activeRecorder = null;
      isCapturing = false;

      if (callbacks) {
        void finishRecordingAndTranscribe(recorder, callbacks);
      } else {
        recorder.cancel();
      }
    },

    cancel: (): void => {
      stopRequestedBeforeReady = true;
      isCapturing = false;
      activeCallbacks = null;
      activeJobId = null;
      if (activeRecorder) {
        activeRecorder.cancel();
        activeRecorder = null;
      }
    },
  };
}
