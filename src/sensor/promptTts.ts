export interface TtsSpeakOptions {
  readonly useFishAudio: boolean;
  readonly onStart?: () => void;
  readonly onEnd?: () => void;
  readonly onError?: (message: string) => void;
}

let activeAudio: HTMLAudioElement | null = null;
let activeObjectUrl: string | null = null;
let activeAbortController: AbortController | null = null;
let playbackToken = 0;

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function findNorwegianVoice(): SpeechSynthesisVoice | null {
  if (!isSpeechSynthesisSupported()) {
    return null;
  }

  const voices = window.speechSynthesis.getVoices();
  const exactNb = voices.find((v) => v.lang.toLowerCase() === 'nb-no');
  if (exactNb) {
    return exactNb;
  }

  const anyNorwegian = voices.find((v) => {
    const lang = v.lang.toLowerCase();
    return lang.startsWith('nb') || lang.startsWith('no') || lang.startsWith('nn');
  });
  return anyNorwegian ?? null;
}

function cleanupAudioElement(): void {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  if (activeAudio) {
    activeAudio.onended = null;
    activeAudio.onerror = null;
    activeAudio.pause();
    activeAudio.src = '';
    activeAudio = null;
  }
  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  }
}

export function stopSpeakingPrompt(): void {
  playbackToken += 1;
  cleanupAudioElement();
  if (isSpeechSynthesisSupported()) {
    window.speechSynthesis.cancel();
  }
}

function speakWithBrowserSynthesis(
  text: string,
  token: number,
  options: TtsSpeakOptions,
  fallbackNotice?: string,
): void {
  if (!isSpeechSynthesisSupported()) {
    options.onEnd?.();
    options.onError?.(
      fallbackNotice || 'Lydavspilling er ikke tilgjengelig i denne nettleseren.',
    );
    return;
  }

  window.speechSynthesis.cancel();

  const voice = findNorwegianVoice();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'nb-NO';
  utterance.rate = 0.95;
  if (voice) {
    utterance.voice = voice;
  }

  utterance.onstart = () => {
    if (token === playbackToken) {
      options.onStart?.();
    }
  };
  utterance.onend = () => {
    if (token === playbackToken) {
      options.onEnd?.();
    }
  };
  utterance.onerror = () => {
    if (token === playbackToken) {
      options.onEnd?.();
      options.onError?.(
        fallbackNotice || 'Kunne ikke spille av norsk stemme i nettleseren.',
      );
    }
  };

  if (fallbackNotice) {
    // Keep playback active when falling back to browser synthesis; only report if synthesis fails.
    utterance.onstart = () => {
      if (token === playbackToken) {
        options.onStart?.();
      }
    };
  }
  window.speechSynthesis.speak(utterance);
}

export function speakNorwegianText(text: string, options: TtsSpeakOptions): void {
  const cleanText = text.trim();
  if (!cleanText) {
    return;
  }

  stopSpeakingPrompt();
  const myToken = playbackToken;

  if (!options.useFishAudio) {
    speakWithBrowserSynthesis(cleanText, myToken, options);
    return;
  }

  const controller = new AbortController();
  activeAbortController = controller;
  options.onStart?.();

  void (async () => {
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: cleanText }),
        signal: controller.signal,
      });

      if (myToken !== playbackToken) {
        return;
      }

      if (!response.ok) {
        const errPayload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(errPayload.error || `Fish Audio feilet (${response.status}).`);
      }

      const audioBlob = await response.blob();
      if (myToken !== playbackToken) {
        return;
      }

      const objectUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(objectUrl);
      activeObjectUrl = objectUrl;
      activeAudio = audio;

      audio.onended = () => {
        if (myToken === playbackToken) {
          cleanupAudioElement();
          options.onEnd?.();
        }
      };
      audio.onerror = () => {
        if (myToken === playbackToken) {
          cleanupAudioElement();
          speakWithBrowserSynthesis(
            cleanText,
            myToken,
            options,
            'Byttet til nettleserens stemme.',
          );
        }
      };

      await audio.play();
    } catch (err: unknown) {
      if (myToken !== playbackToken) {
        return;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      cleanupAudioElement();
      const notice =
        err instanceof Error
          ? `${err.message} Bruker nettleserens stemme.`
          : 'Bruker nettleserens stemme.';
      speakWithBrowserSynthesis(cleanText, myToken, options, notice);
    }
  })();
}
