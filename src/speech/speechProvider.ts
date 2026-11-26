export interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence: number;
}

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike | undefined;
}

export interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike | undefined;
}

export interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

export interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message: string;
}

export interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

interface WebSpeechWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

export interface SpeechCaptureCallbacks {
  readonly onInterim?: (transcript: string) => void;
  readonly onProcessing?: () => void;
  readonly onFinal: (transcript: string) => void;
  readonly onError: (message: string) => void;
  readonly onEnd: () => void;
}

/**
 * Provider abstraction so local Transformers.js Web Worker and Web Speech API
 * share a single contract with zero UI/SRS coupling.
 */
export interface SpeechRecognizer {
  readonly isSupported: () => boolean;
  readonly unsupportedReason: () => string | null;
  readonly start: (callbacks: SpeechCaptureCallbacks) => boolean;
  readonly stop: () => void;
  readonly cancel?: () => void;
}

function getSpeechConstructor(): SpeechRecognitionConstructor | null {
  const speechWindow = window as WebSpeechWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function formatSpeechError(errorCode: string, message: string): string {
  switch (errorCode) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission denied. Allow mic access in browser settings.';
    case 'audio-capture':
      return 'No microphone input detected. Check your audio input device.';
    case 'no-speech':
      return 'No Norwegian speech detected. Hold and speak closer to the mic.';
    case 'network':
      return 'Web Speech API network error (browser speech service unreachable).';
    case 'language-not-supported':
      return 'Norwegian Bokmål (nb-NO) speech recognition is not supported on this device.';
    case 'aborted':
      return 'Speech capture cancelled.';
    default:
      return message ? `Speech recognition error (${errorCode}): ${message}` : `Speech recognition error: ${errorCode}`;
  }
}

export function createWebSpeechRecognizer(lang: string = 'nb-NO'): SpeechRecognizer {
  let activeRecognition: SpeechRecognitionInstance | null = null;
  let capturedTranscript = '';
  let hadError = false;

  const isSupported = (): boolean => getSpeechConstructor() !== null;

  const unsupportedReason = (): string | null => {
    if (isSupported()) {
      return null;
    }
    return 'Speech recognition unavailable: this browser does not support SpeechRecognition or webkitSpeechRecognition.';
  };

  return {
    isSupported,
    unsupportedReason,

    start: (callbacks: SpeechCaptureCallbacks): boolean => {
      const RecognitionCtor = getSpeechConstructor();
      if (!RecognitionCtor) {
        callbacks.onError(unsupportedReason() ?? 'Web Speech API unavailable.');
        callbacks.onEnd();
        return false;
      }

      if (activeRecognition) {
        activeRecognition.abort();
        activeRecognition = null;
      }

      capturedTranscript = '';
      hadError = false;

      const recognition = new RecognitionCtor();
      recognition.lang = lang;
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event: SpeechRecognitionEventLike): void => {
        let interim = '';
        let finalText = '';

        for (let i = 0; i < event.results.length; i += 1) {
          const result = event.results[i];
          const alt = result?.[0];
          if (!result || !alt) {
            continue;
          }
          if (result.isFinal) {
            finalText += alt.transcript;
          } else {
            interim += alt.transcript;
          }
        }

        const latest = (finalText || interim).trim();
        if (latest) {
          capturedTranscript = latest;
          if (!finalText && callbacks.onInterim) {
            callbacks.onInterim(latest);
          }
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEventLike): void => {
        hadError = true;
        callbacks.onError(formatSpeechError(event.error, event.message));
      };

      recognition.onend = (): void => {
        activeRecognition = null;
        if (!hadError) {
          callbacks.onFinal(capturedTranscript);
        }
        callbacks.onEnd();
      };

      activeRecognition = recognition;
      try {
        recognition.start();
        return true;
      } catch (err: unknown) {
        activeRecognition = null;
        const detail = err instanceof Error ? err.message : 'Unable to start speech recognition.';
        callbacks.onError(detail);
        callbacks.onEnd();
        return false;
      }
    },

    stop: (): void => {
      if (activeRecognition) {
        activeRecognition.stop();
      }
    },
  };
}
