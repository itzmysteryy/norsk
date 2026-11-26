import './style.css';
import type { Grade } from 'ts-fsrs';
import {
  checkAuthSession,
  lockSession,
  unlockWithPassword,
  type AuthSessionStatus,
} from './auth/authClient.ts';
import rawDeck from './data/deck.json';
import rawSensorPrompts from './data/sensorPrompts.json';
import { bindKeyboardControls } from './input/keyboard.ts';
import { evaluateWithGroq } from './sensor/groqClient.ts';
import { speakNorwegianText, stopSpeakingPrompt } from './sensor/promptTts.ts';
import { evaluateSensorResponse } from './sensor/rubricEvaluator.ts';
import { createSensorLlmClient, detectWebGpuSupport } from './sensor/sensorLlmClient.ts';
import {
  createLocalWhisperRecognizer,
  type ModelStatus,
} from './speech/localWhisperProvider.ts';
import { evaluatePronunciation } from './speech/pronunciationDiff.ts';
import {
  computeMetrics,
  createSrsEngine,
  selectNextCard,
  type SrsEngine,
} from './srs/fsrsEngine.ts';
import {
  addCardToDeck,
  appendReviewLog,
  initializeDeckStore,
  loadStoredCards,
  resetDeckStore,
  saveStoredCards,
} from './storage/deckStorage.ts';
import {
  clearSensorHistory,
  loadSensorHistory,
  saveSensorAttempt,
} from './storage/sensorStorage.ts';
import type { CardContent, StoredSrsCard } from './types/card.ts';
import type {
  AppMode,
  CefrLevel,
  SensorAttempt,
  SensorPrompt,
  SensorRuntimeState,
  SpeakingTarget,
} from './types/sensor.ts';
import {
  bindHudClickActions,
  renderHudView,
  type SpeechPanelState,
} from './ui/hudRenderer.ts';
import {
  bindSensorClickActions,
  buildSpokenFeedbackText,
  renderSensorWorkspace,
  SENSOR_HARD_CAP_MS,
  updateSensorStopwatchDom,
} from './ui/sensorRenderer.ts';

const INITIAL_DECK: readonly CardContent[] = rawDeck;
const SENSOR_PROMPTS: readonly SensorPrompt[] = rawSensorPrompts as SensorPrompt[];

const authGate = document.querySelector<HTMLDivElement>('#auth-gate');
const authCheckingMsg = document.querySelector<HTMLParagraphElement>('#auth-checking-msg');
const authForm = document.querySelector<HTMLFormElement>('#auth-form');
const authPasswordInput = document.querySelector<HTMLInputElement>('#auth-password-input');
const authErrorBox = document.querySelector<HTMLDivElement>('#auth-error');
const authSubmitBtn = document.querySelector<HTMLButtonElement>('#auth-submit-btn');

const appRoot = document.querySelector<HTMLDivElement>('#app');
const holdToSpeakBtn = document.querySelector<HTMLButtonElement>('#hold-to-speak-btn');
const srsWorkspace = document.querySelector<HTMLDivElement>('#srs-workspace');
const sensorWorkspace = document.querySelector<HTMLDivElement>('#sensor-workspace');
const srsHeaderControls = document.querySelector<HTMLDivElement>('#srs-header-controls');
const modeSrsBtn = document.querySelector<HTMLButtonElement>('#mode-srs-btn');
const modeSensorBtn = document.querySelector<HTMLButtonElement>('#mode-sensor-btn');
const lockAppBtn = document.querySelector<HTMLButtonElement>('#lock-app-btn');
const footerHints = document.querySelector<HTMLDivElement>('#footer-hints');
const footerPhase = document.querySelector<HTMLSpanElement>('#footer-phase');

if (
  !authGate ||
  !authCheckingMsg ||
  !authForm ||
  !authPasswordInput ||
  !authErrorBox ||
  !authSubmitBtn ||
  !appRoot ||
  !holdToSpeakBtn ||
  !srsWorkspace ||
  !sensorWorkspace ||
  !srsHeaderControls ||
  !modeSrsBtn ||
  !modeSensorBtn ||
  !lockAppBtn ||
  !footerHints ||
  !footerPhase
) {
  throw new Error('Required application mount nodes were not found in index.html.');
}

interface AppRuntimeState {
  isAuthenticated: boolean;
  appBootstrapped: boolean;
  mode: AppMode;
  engine: SrsEngine | null;
  activeCard: StoredSrsCard | null;
  isFlipped: boolean;
  isBusy: boolean;
  isSpeakingWord: boolean;
  isSrsListening: boolean;
  speechState: SpeechPanelState;
  modelStatus: ModelStatus;
  sensor: SensorRuntimeState;
  stopwatchTimerId: number | null;
  recordingStartedAt: number | null;
}

const localWhisper = createLocalWhisperRecognizer({
  onModelStatus: (status) => {
    runtime.modelStatus = status;
    if (status.phase === 'error') {
      if (runtime.speechState.kind === 'processing') {
        runtime.speechState = { kind: 'error', message: status.message };
      }
      if (runtime.sensor.phase === 'transcribing') {
        runtime.sensor = {
          ...runtime.sensor,
          phase: 'error',
          errorMessage: status.message,
        };
      }
    }
    if (!runtime.appBootstrapped) {
      return;
    }
    if (runtime.mode === 'srs') {
      void renderCard(true);
    } else {
      renderSensor();
    }
  },
});

const llmClient = createSensorLlmClient((aiStatus) => {
  runtime.sensor = {
    ...runtime.sensor,
    aiStatus,
  };
  if (runtime.appBootstrapped && runtime.mode === 'sensor') {
    renderSensor();
  }
});

const unsupportedMessage = localWhisper.unsupportedReason();

const runtime: AppRuntimeState = {
  isAuthenticated: false,
  appBootstrapped: false,
  mode: 'srs',
  engine: null,
  activeCard: null,
  isFlipped: false,
  isBusy: true,
  isSpeakingWord: false,
  isSrsListening: false,
  speechState: unsupportedMessage
    ? { kind: 'unsupported', message: unsupportedMessage }
    : { kind: 'idle' },
  modelStatus: { phase: 'idle' },
  sensor: {
    selectedLevel: 'B1',
    promptIndexByLevel: { A2: 0, B1: 0, B2: 0 },
    phase: 'ready',
    elapsedMs: 0,
    lastDurationMs: 0,
    transcript: '',
    evaluation: null,
    evaluatorProvider: 'groq',
    groqConfigured: false,
    fishAudioConfigured: false,
    autoSpeakFeedback: true,
    groqLoading: false,
    aiCritique: null,
    aiErrorMessage: null,
    aiStatus: { phase: 'disabled' },
    webGpuAvailable: false,
    history: [],
    addedCardIds: [],
    errorMessage: null,
    showHint: false,
    showFollowUp: false,
    showSettings: false,
    speakingTarget: null,
    ttsStatusMessage: null,
  },
  stopwatchTimerId: null,
  recordingStartedAt: null,
};

function defaultSpeechState(): SpeechPanelState {
  const reason = localWhisper.unsupportedReason();
  return reason ? { kind: 'unsupported', message: reason } : { kind: 'idle' };
}

function getPromptsForLevel(level: CefrLevel): readonly SensorPrompt[] {
  return SENSOR_PROMPTS.filter((p) => p.level === level);
}

function getActiveSensorPrompt(): {
  readonly prompt: SensorPrompt;
  readonly current: number;
  readonly total: number;
} {
  const list = getPromptsForLevel(runtime.sensor.selectedLevel);
  const idx = runtime.sensor.promptIndexByLevel[runtime.sensor.selectedLevel] % list.length;
  const prompt = list[idx] ?? SENSOR_PROMPTS[0]!;
  return {
    prompt,
    current: idx + 1,
    total: list.length,
  };
}

function clearStopwatchTimer(): void {
  if (runtime.stopwatchTimerId !== null) {
    window.clearInterval(runtime.stopwatchTimerId);
    runtime.stopwatchTimerId = null;
  }
}

function showLockedGate(errorMessage: string | null = null): void {
  runtime.isAuthenticated = false;
  stopSpeakingPrompt();
  clearStopwatchTimer();
  localWhisper.cancel();
  runtime.isSrsListening = false;
  runtime.isSpeakingWord = false;

  appRoot!.classList.add('hidden');
  appRoot!.classList.remove('flex');
  authGate!.classList.remove('hidden');
  authGate!.classList.add('flex');

  authCheckingMsg!.classList.add('hidden');
  authForm!.classList.remove('hidden');
  authForm!.classList.add('flex');
  authPasswordInput!.value = '';

  if (errorMessage) {
    authErrorBox!.textContent = errorMessage;
    authErrorBox!.classList.remove('hidden');
  } else {
    authErrorBox!.classList.add('hidden');
  }

  window.setTimeout(() => authPasswordInput!.focus(), 20);
}

function showUnlockedApp(): void {
  runtime.isAuthenticated = true;
  authGate!.classList.add('hidden');
  authGate!.classList.remove('flex');
  appRoot!.classList.remove('hidden');
  appRoot!.classList.add('flex');
}

function updateModeChrome(): void {
  const isSrs = runtime.mode === 'srs';

  srsWorkspace!.classList.toggle('hidden', !isSrs);
  srsWorkspace!.classList.toggle('flex', isSrs);
  srsHeaderControls!.classList.toggle('hidden', !isSrs);
  srsHeaderControls!.classList.toggle('flex', isSrs);

  sensorWorkspace!.classList.toggle('hidden', isSrs);
  sensorWorkspace!.classList.toggle('flex', !isSrs);

  modeSrsBtn!.setAttribute('aria-selected', String(isSrs));
  modeSensorBtn!.setAttribute('aria-selected', String(!isSrs));

  const activeTabClass =
    'cursor-pointer rounded-md px-3 py-1 font-medium transition bg-[#1e2614] text-[#d2e4ab] border border-[#849e52]/40';
  const inactiveTabClass =
    'cursor-pointer rounded-md px-3 py-1 font-medium transition text-slate-400 hover:text-slate-200 border border-transparent';

  modeSrsBtn!.className = isSrs ? activeTabClass : inactiveTabClass;
  modeSensorBtn!.className = !isSrs ? activeTabClass : inactiveTabClass;

  if (isSrs) {
    footerHints!.innerHTML = `
      <span class="inline-flex items-center gap-1.5">
        <kbd class="rounded border border-slate-700/70 bg-slate-900/90 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">V</kbd>
        <span>Hold og snakk</span>
      </span>
      <span class="inline-flex items-center gap-1.5">
        <kbd class="rounded border border-slate-700/70 bg-slate-900/90 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">SPACE</kbd>
        <span>Vis svar</span>
      </span>
      <span class="inline-flex items-center gap-1.5">
        <kbd class="rounded border border-slate-700/70 bg-slate-900/90 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">1–4</kbd>
        <span>Vurder</span>
      </span>
    `;
    footerPhase!.textContent = 'Norsk uttale';
  } else {
    footerHints!.innerHTML = `
      <span class="inline-flex items-center gap-1.5">
        <kbd class="rounded border border-slate-700/70 bg-slate-900/90 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">SPACE</kbd>
        <span>Start / stopp svar</span>
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="text-[#a3bd6f]">1:30–2:00</span>
        <span>Anbefalt tid</span>
      </span>
    `;
    footerPhase!.textContent = 'Muntlig sensor';
  }
}

function renderSensor(): void {
  const { prompt, current, total } = getActiveSensorPrompt();
  renderSensorWorkspace(sensorWorkspace!, {
    prompt,
    promptPosition: { current, total },
    state: runtime.sensor,
    modelStatus: runtime.modelStatus,
    micUnsupportedReason: localWhisper.unsupportedReason(),
  });
}

async function renderCard(preserveCardState: boolean = false): Promise<void> {
  if (!runtime.engine) {
    return;
  }

  const now = new Date();
  const cards = await loadStoredCards();
  const nextCard = selectNextCard(cards, now);
  const metrics = computeMetrics(cards, now);

  runtime.activeCard = nextCard;
  if (!nextCard || !preserveCardState) {
    runtime.isFlipped = false;
    runtime.speechState = defaultSpeechState();
  }

  const intervals =
    nextCard !== null ? runtime.engine.previewIntervals(nextCard.fsrs, now) : null;

  renderHudView({
    activeCard: runtime.activeCard,
    isFlipped: runtime.isFlipped,
    isBusy: runtime.isBusy,
    isSpeakingWord: runtime.isSpeakingWord,
    intervals,
    metrics,
    speechState: runtime.speechState,
    modelStatus: runtime.modelStatus,
  });
}

function switchMode(nextMode: AppMode): void {
  if (!runtime.isAuthenticated || runtime.mode === nextMode) {
    return;
  }

  stopSpeakingPrompt();
  clearStopwatchTimer();
  localWhisper.cancel();
  runtime.isSrsListening = false;
  runtime.isSpeakingWord = false;
  runtime.recordingStartedAt = null;
  if (runtime.sensor.phase === 'recording' || runtime.sensor.phase === 'transcribing') {
    runtime.sensor = {
      ...runtime.sensor,
      phase: 'ready',
      elapsedMs: 0,
      speakingTarget: null,
    };
  } else {
    runtime.sensor = {
      ...runtime.sensor,
      speakingTarget: null,
    };
  }

  runtime.mode = nextMode;
  updateModeChrome();

  if (nextMode === 'srs') {
    void renderCard(true);
  } else {
    renderSensor();
  }
}

function speakSensorText(text: string, target: Exclude<SpeakingTarget, null>): void {
  if (runtime.sensor.speakingTarget === target) {
    stopSpeakingPrompt();
    runtime.sensor = {
      ...runtime.sensor,
      speakingTarget: null,
    };
    renderSensor();
    return;
  }

  runtime.sensor = {
    ...runtime.sensor,
    speakingTarget: target,
    ttsStatusMessage: null,
  };
  renderSensor();

  speakNorwegianText(text, {
    useFishAudio: runtime.sensor.fishAudioConfigured,
    onStart: () => {
      runtime.sensor = {
        ...runtime.sensor,
        speakingTarget: target,
      };
      if (runtime.mode === 'sensor') {
        renderSensor();
      }
    },
    onEnd: () => {
      runtime.sensor = {
        ...runtime.sensor,
        speakingTarget: null,
      };
      if (runtime.mode === 'sensor') {
        renderSensor();
      }
    },
    onError: (message) => {
      runtime.sensor = {
        ...runtime.sensor,
        speakingTarget: null,
        ttsStatusMessage: message,
      };
      if (runtime.mode === 'sensor') {
        renderSensor();
      }
    },
  });
}

function speakActiveWord(): void {
  if (!runtime.activeCard) {
    return;
  }

  if (runtime.isSpeakingWord) {
    stopSpeakingPrompt();
    runtime.isSpeakingWord = false;
    void renderCard(true);
    return;
  }

  runtime.isSpeakingWord = true;
  void renderCard(true);

  speakNorwegianText(runtime.activeCard.content.word, {
    useFishAudio: runtime.sensor.fishAudioConfigured,
    onEnd: () => {
      runtime.isSpeakingWord = false;
      if (runtime.mode === 'srs') {
        void renderCard(true);
      }
    },
    onError: () => {
      runtime.isSpeakingWord = false;
      if (runtime.mode === 'srs') {
        void renderCard(true);
      }
    },
  });
}

function startSrsSpeechCapture(): void {
  if (
    !runtime.isAuthenticated ||
    runtime.mode !== 'srs' ||
    runtime.isBusy ||
    !runtime.activeCard ||
    runtime.isSrsListening
  ) {
    return;
  }

  if (!localWhisper.isSupported()) {
    runtime.speechState = {
      kind: 'unsupported',
      message:
        localWhisper.unsupportedReason() ??
        'Mikrofon er ikke tilgjengelig i denne nettleseren.',
    };
    void renderCard(true);
    return;
  }

  const targetWord = runtime.activeCard.content.word;
  const targetCardId = runtime.activeCard.content.id;

  runtime.isSrsListening = true;
  runtime.speechState = { kind: 'listening', interim: '' };
  void renderCard(true);

  localWhisper.start({
    onInterim: (interim) => {
      if (runtime.mode !== 'srs' || runtime.activeCard?.content.id !== targetCardId) {
        return;
      }
      runtime.speechState = { kind: 'listening', interim };
      void renderCard(true);
    },
    onProcessing: () => {
      if (runtime.mode !== 'srs' || runtime.activeCard?.content.id !== targetCardId) {
        return;
      }
      runtime.speechState = { kind: 'processing' };
      void renderCard(true);
    },
    onFinal: (rawTranscript) => {
      if (runtime.mode !== 'srs' || runtime.activeCard?.content.id !== targetCardId) {
        return;
      }
      if (!rawTranscript.trim()) {
        runtime.speechState = {
          kind: 'error',
          message: 'Jeg hørte ikke noe ord. Hold knappen inne og snakk tydelig.',
        };
        return;
      }

      const evaluation = evaluatePronunciation(targetWord, rawTranscript);
      runtime.speechState = { kind: 'graded', evaluation };
    },
    onError: (message) => {
      if (runtime.mode === 'srs') {
        runtime.speechState = { kind: 'error', message };
      }
    },
    onEnd: () => {
      runtime.isSrsListening = false;
      if (runtime.mode === 'srs') {
        void renderCard(true);
      }
    },
  });
}

function stopSrsSpeechCapture(): void {
  if (!runtime.isSrsListening) {
    return;
  }
  localWhisper.stop();
}

async function runAiCritiqueForCurrentAnswer(): Promise<void> {
  const evaluation = runtime.sensor.evaluation;
  const provider = runtime.sensor.evaluatorProvider;
  if (runtime.sensor.phase !== 'evaluated' || !evaluation || provider === 'rubric') {
    return;
  }

  const { prompt } = getActiveSensorPrompt();
  const transcriptSnapshot = runtime.sensor.transcript;

  if (provider === 'groq') {
    if (runtime.sensor.groqLoading) {
      return;
    }

    runtime.sensor = {
      ...runtime.sensor,
      groqLoading: true,
      aiErrorMessage: null,
    };
    renderSensor();

    try {
      const critique = await evaluateWithGroq({
        level: prompt.level,
        promptNb: prompt.promptNb,
        transcript: transcriptSnapshot,
        durationSeconds: evaluation.durationSeconds,
      });

      if (runtime.sensor.transcript !== transcriptSnapshot) {
        return;
      }

      runtime.sensor = {
        ...runtime.sensor,
        groqLoading: false,
        aiCritique: critique,
        aiErrorMessage: null,
      };

      if (runtime.mode === 'sensor') {
        renderSensor();
        if (runtime.sensor.autoSpeakFeedback) {
          speakSensorText(buildSpokenFeedbackText(evaluation, critique), 'feedback');
        }
      }
    } catch (err: unknown) {
      runtime.sensor = {
        ...runtime.sensor,
        groqLoading: false,
        aiErrorMessage: err instanceof Error ? err.message : 'Kunne ikke hente vurdering.',
      };
      if (runtime.mode === 'sensor') {
        renderSensor();
      }
    }
    return;
  }

  const aiPhase = runtime.sensor.aiStatus.phase;
  if (aiPhase === 'disabled' || aiPhase === 'error' || aiPhase === 'running') {
    return;
  }

  runtime.sensor = {
    ...runtime.sensor,
    aiErrorMessage: null,
  };
  renderSensor();

  try {
    const critique = await llmClient.critique({
      level: prompt.level,
      promptNb: prompt.promptNb,
      transcript: transcriptSnapshot,
      durationSeconds: evaluation.durationSeconds,
    });

    if (runtime.sensor.transcript !== transcriptSnapshot) {
      return;
    }

    runtime.sensor = {
      ...runtime.sensor,
      aiCritique: critique,
      aiErrorMessage: null,
    };

    if (runtime.mode === 'sensor') {
      renderSensor();
      if (runtime.sensor.autoSpeakFeedback) {
        speakSensorText(buildSpokenFeedbackText(evaluation, critique), 'feedback');
      }
    }
  } catch (err: unknown) {
    runtime.sensor = {
      ...runtime.sensor,
      aiErrorMessage: err instanceof Error ? err.message : 'Lokal AI feilet.',
    };
    if (runtime.mode === 'sensor') {
      renderSensor();
    }
  }
}

function stopSensorRecording(): void {
  if (runtime.sensor.phase !== 'recording') {
    return;
  }
  clearStopwatchTimer();
  const durationMs =
    runtime.recordingStartedAt !== null
      ? Date.now() - runtime.recordingStartedAt
      : runtime.sensor.elapsedMs;
  runtime.recordingStartedAt = null;
  runtime.sensor = {
    ...runtime.sensor,
    phase: 'transcribing',
    elapsedMs: durationMs,
    lastDurationMs: durationMs,
  };
  renderSensor();
  localWhisper.stop();
}

function startSensorRecording(): void {
  if (!runtime.isAuthenticated || runtime.mode !== 'sensor') {
    return;
  }
  if (runtime.sensor.phase === 'recording' || runtime.sensor.phase === 'transcribing') {
    return;
  }

  const unsupported = localWhisper.unsupportedReason();
  if (unsupported) {
    runtime.sensor = {
      ...runtime.sensor,
      phase: 'error',
      errorMessage: unsupported,
    };
    renderSensor();
    return;
  }

  stopSpeakingPrompt();
  const { prompt } = getActiveSensorPrompt();
  runtime.recordingStartedAt = Date.now();
  runtime.sensor = {
    ...runtime.sensor,
    phase: 'recording',
    elapsedMs: 0,
    evaluation: null,
    groqLoading: false,
    aiCritique: null,
    aiErrorMessage: null,
    errorMessage: null,
    speakingTarget: null,
  };
  renderSensor();

  clearStopwatchTimer();
  runtime.stopwatchTimerId = window.setInterval(() => {
    if (runtime.sensor.phase !== 'recording' || runtime.recordingStartedAt === null) {
      clearStopwatchTimer();
      return;
    }
    const elapsed = Date.now() - runtime.recordingStartedAt;
    runtime.sensor = {
      ...runtime.sensor,
      elapsedMs: elapsed,
    };
    updateSensorStopwatchDom(elapsed, 'recording');

    if (elapsed >= SENSOR_HARD_CAP_MS) {
      stopSensorRecording();
    }
  }, 100);

  localWhisper.start({
    onProcessing: () => {
      if (runtime.mode !== 'sensor') {
        return;
      }
      clearStopwatchTimer();
      runtime.sensor = {
        ...runtime.sensor,
        phase: 'transcribing',
      };
      renderSensor();
    },
    onFinal: (rawTranscript) => {
      if (runtime.mode !== 'sensor') {
        return;
      }
      const cleanTranscript = rawTranscript.trim();
      if (!cleanTranscript) {
        runtime.sensor = {
          ...runtime.sensor,
          phase: 'error',
          errorMessage: 'Jeg hørte ikke noe norsk tale. Sjekk mikrofonen og prøv igjen.',
        };
        return;
      }

      const durationMs = Math.max(1000, runtime.sensor.lastDurationMs);
      const evaluation = evaluateSensorResponse(prompt, cleanTranscript, durationMs);
      const attempt: SensorAttempt = {
        id: `attempt-${Date.now()}`,
        promptId: prompt.id,
        level: prompt.level,
        topic: prompt.topic,
        promptNb: prompt.promptNb,
        transcript: cleanTranscript,
        durationMs,
        evaluation,
        createdAt: Date.now(),
      };

      runtime.sensor = {
        ...runtime.sensor,
        phase: 'evaluated',
        transcript: cleanTranscript,
        evaluation,
        aiCritique: null,
        aiErrorMessage: null,
        errorMessage: null,
      };

      void saveSensorAttempt(attempt).then((updatedHistory) => {
        runtime.sensor = {
          ...runtime.sensor,
          history: updatedHistory,
        };
        if (runtime.mode === 'sensor') {
          renderSensor();
        }
      });

      const shouldAutoRunGroq =
        runtime.sensor.evaluatorProvider === 'groq' && runtime.sensor.groqConfigured;
      const shouldAutoRunLocal =
        runtime.sensor.evaluatorProvider === 'local-ai' &&
        runtime.sensor.aiStatus.phase === 'ready';

      if (shouldAutoRunGroq || shouldAutoRunLocal) {
        void runAiCritiqueForCurrentAnswer();
      } else if (runtime.sensor.autoSpeakFeedback) {
        speakSensorText(buildSpokenFeedbackText(evaluation, null), 'feedback');
      }
    },
    onError: (message) => {
      if (runtime.mode !== 'sensor') {
        return;
      }
      clearStopwatchTimer();
      runtime.recordingStartedAt = null;
      runtime.sensor = {
        ...runtime.sensor,
        phase: 'error',
        errorMessage: message,
      };
    },
    onEnd: () => {
      clearStopwatchTimer();
      runtime.recordingStartedAt = null;
      if (runtime.mode === 'sensor') {
        renderSensor();
      }
    },
  });
}

function toggleSensorRecording(): void {
  if (!runtime.isAuthenticated) {
    return;
  }
  if (runtime.sensor.phase === 'recording') {
    stopSensorRecording();
  } else if (runtime.sensor.phase !== 'transcribing') {
    startSensorRecording();
  }
}

async function handleAddCardToDeck(card: CardContent): Promise<void> {
  if (!runtime.engine) {
    return;
  }

  const { cards } = await addCardToDeck(card, runtime.engine);
  runtime.sensor = {
    ...runtime.sensor,
    addedCardIds: cards.map((item) => item.content.id),
  };
  if (runtime.mode === 'sensor') {
    renderSensor();
  }
  await renderCard(true);
}

function buildAiSuggestedCard(index: number): CardContent | null {
  const corr = runtime.sensor.aiCritique?.corrections[index];
  if (!corr) {
    return null;
  }
  const slug = corr.corrected
    .toLowerCase()
    .replaceAll(/[^a-zæøå0-9]+/g, '-')
    .slice(0, 24);
  return {
    id: `nb-ai-corr-${index}-${slug}`,
    word: corr.corrected,
    ipa: '/norsk/',
    partOfSpeech: 'uttrykk',
    english: corr.note,
    exampleNb: corr.corrected,
    exampleEn: `I stedet for: «${corr.original}»`,
    phoneticTip: corr.note,
  };
}

function bindHoldToSpeakButton(button: HTMLButtonElement): void {
  button.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || button.disabled) {
      return;
    }
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
    startSrsSpeechCapture();
  });

  const endHold = (): void => {
    stopSrsSpeechCapture();
  };

  button.addEventListener('pointerup', endHold);
  button.addEventListener('pointercancel', endHold);
  button.addEventListener('lostpointercapture', endHold);

  button.addEventListener('keydown', (event: KeyboardEvent) => {
    if ((event.code === 'Space' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault();
      startSrsSpeechCapture();
    }
  });

  button.addEventListener('keyup', (event: KeyboardEvent) => {
    if (event.code === 'Space' || event.key === 'Enter') {
      event.preventDefault();
      stopSrsSpeechCapture();
    }
  });
}

function flipCurrentCard(): void {
  if (
    !runtime.isAuthenticated ||
    runtime.mode !== 'srs' ||
    runtime.isBusy ||
    !runtime.activeCard ||
    runtime.isFlipped
  ) {
    return;
  }
  runtime.isFlipped = true;
  void renderCard(true);
}

async function rateCurrentCard(grade: Grade): Promise<void> {
  if (
    !runtime.isAuthenticated ||
    runtime.mode !== 'srs' ||
    runtime.isBusy ||
    !runtime.engine ||
    !runtime.activeCard ||
    !runtime.isFlipped
  ) {
    return;
  }

  stopSrsSpeechCapture();
  runtime.isBusy = true;
  try {
    const now = new Date();
    const targetId = runtime.activeCard.content.id;
    const cards = await loadStoredCards();
    const current = cards.find((item) => item.content.id === targetId);

    if (!current) {
      return;
    }

    const { card: scheduledCard, revlog } = runtime.engine.scheduleReview(
      current.fsrs,
      grade,
      now,
    );

    const updatedCards = cards.map((item) =>
      item.content.id === targetId ? { ...item, fsrs: scheduledCard } : item,
    );

    await saveStoredCards(updatedCards);
    await appendReviewLog(revlog);
  } finally {
    runtime.isBusy = false;
    await renderCard(false);
  }
}

async function resetDeck(): Promise<void> {
  if (!runtime.isAuthenticated || runtime.isBusy || !runtime.engine) {
    return;
  }

  stopSrsSpeechCapture();
  runtime.isBusy = true;
  try {
    const fresh = await resetDeckStore(INITIAL_DECK, runtime.engine);
    runtime.sensor = {
      ...runtime.sensor,
      addedCardIds: fresh.map((c) => c.content.id),
    };
  } finally {
    runtime.isBusy = false;
    await renderCard(false);
  }
}

async function bootstrapApp(session: AuthSessionStatus): Promise<void> {
  runtime.sensor = {
    ...runtime.sensor,
    groqConfigured: session.groqConfigured,
    fishAudioConfigured: session.fishAudioConfigured,
  };

  if (runtime.appBootstrapped) {
    showUnlockedApp();
    if (runtime.mode === 'srs') {
      await renderCard(true);
    } else {
      renderSensor();
    }
    return;
  }

  runtime.appBootstrapped = true;

  const [engine, webGpuAvailable] = await Promise.all([
    createSrsEngine(),
    detectWebGpuSupport(),
  ]);
  runtime.engine = engine;

  const initialCards = await initializeDeckStore(INITIAL_DECK, engine);
  const history = await loadSensorHistory();
  runtime.sensor = {
    ...runtime.sensor,
    webGpuAvailable,
    history,
    addedCardIds: initialCards.map((c) => c.content.id),
  };
  runtime.isBusy = false;

  modeSrsBtn!.addEventListener('click', () => switchMode('srs'));
  modeSensorBtn!.addEventListener('click', () => switchMode('sensor'));
  lockAppBtn!.addEventListener('click', () => {
    void lockSession().finally(() => {
      showLockedGate();
    });
  });

  bindHoldToSpeakButton(holdToSpeakBtn!);

  bindHudClickActions(appRoot!, {
    onFlip: flipCurrentCard,
    onRate: (grade) => {
      void rateCurrentCard(grade);
    },
    onReset: () => {
      void resetDeck();
    },
    onSpeakWord: speakActiveWord,
  });

  bindSensorClickActions(
    sensorWorkspace!,
    {
      onSelectLevel: (level) => {
        stopSpeakingPrompt();
        runtime.sensor = {
          ...runtime.sensor,
          selectedLevel: level,
          phase: 'ready',
          elapsedMs: 0,
          lastDurationMs: 0,
          transcript: '',
          evaluation: null,
          groqLoading: false,
          aiCritique: null,
          aiErrorMessage: null,
          errorMessage: null,
          showFollowUp: false,
          speakingTarget: null,
          ttsStatusMessage: null,
        };
        renderSensor();
      },
      onSelectEvaluator: (provider) => {
        runtime.sensor = {
          ...runtime.sensor,
          evaluatorProvider: provider,
          aiCritique: null,
          aiErrorMessage: null,
        };
        renderSensor();
      },
      onNextPrompt: () => {
        stopSpeakingPrompt();
        const level = runtime.sensor.selectedLevel;
        const list = getPromptsForLevel(level);
        const nextIdx = (runtime.sensor.promptIndexByLevel[level] + 1) % list.length;
        runtime.sensor = {
          ...runtime.sensor,
          promptIndexByLevel: {
            ...runtime.sensor.promptIndexByLevel,
            [level]: nextIdx,
          },
          phase: 'ready',
          elapsedMs: 0,
          lastDurationMs: 0,
          transcript: '',
          evaluation: null,
          groqLoading: false,
          aiCritique: null,
          aiErrorMessage: null,
          errorMessage: null,
          showHint: false,
          showFollowUp: false,
          speakingTarget: null,
          ttsStatusMessage: null,
        };
        renderSensor();
      },
      onToggleHint: () => {
        runtime.sensor = {
          ...runtime.sensor,
          showHint: !runtime.sensor.showHint,
        };
        renderSensor();
      },
      onToggleSettings: () => {
        runtime.sensor = {
          ...runtime.sensor,
          showSettings: !runtime.sensor.showSettings,
        };
        renderSensor();
      },
      onToggleAutoSpeak: () => {
        runtime.sensor = {
          ...runtime.sensor,
          autoSpeakFeedback: !runtime.sensor.autoSpeakFeedback,
        };
        renderSensor();
      },
      onSpeakPrompt: () => {
        const { prompt } = getActiveSensorPrompt();
        speakSensorText(prompt.promptNb, 'prompt');
      },
      onSpeakFeedback: (text) => {
        speakSensorText(text, 'feedback');
      },
      onSpeakFollowUp: (text) => {
        runtime.sensor = {
          ...runtime.sensor,
          showFollowUp: true,
        };
        speakSensorText(text, 'followup');
      },
      onToggleFollowUp: () => {
        runtime.sensor = {
          ...runtime.sensor,
          showFollowUp: !runtime.sensor.showFollowUp,
        };
        renderSensor();
      },
      onToggleRecording: toggleSensorRecording,
      onEnableAiSensor: () => {
        llmClient.enableAndWarmup();
      },
      onRunAiCritique: () => {
        void runAiCritiqueForCurrentAnswer();
      },
      onAddCardToDeck: (card) => {
        void handleAddCardToDeck(card);
      },
      onClearHistory: () => {
        void clearSensorHistory().then(() => {
          runtime.sensor = {
            ...runtime.sensor,
            history: [],
          };
          if (runtime.mode === 'sensor') {
            renderSensor();
          }
        });
      },
    },
    (index) => runtime.sensor.evaluation?.suggestedCards[index] ?? null,
    buildAiSuggestedCard,
    () => {
      if (!runtime.sensor.evaluation) {
        return '';
      }
      return buildSpokenFeedbackText(runtime.sensor.evaluation, runtime.sensor.aiCritique);
    },
    () => {
      const { prompt } = getActiveSensorPrompt();
      return runtime.sensor.aiCritique?.followUpNb || prompt.followUpNb;
    },
  );

  bindKeyboardControls({
    getMode: () => runtime.mode,
    canFlip: () =>
      runtime.isAuthenticated && !runtime.isBusy && runtime.activeCard !== null && !runtime.isFlipped,
    canRate: () =>
      runtime.isAuthenticated && !runtime.isBusy && runtime.activeCard !== null && runtime.isFlipped,
    canSpeak: () =>
      runtime.isAuthenticated && !runtime.isBusy && runtime.activeCard !== null,
    onFlip: flipCurrentCard,
    onRate: (grade) => {
      void rateCurrentCard(grade);
    },
    onReset: () => {
      void resetDeck();
    },
    onSpeakStart: startSrsSpeechCapture,
    onSpeakStop: stopSrsSpeechCapture,
    onSensorToggleRecord: toggleSensorRecording,
  });

  showUnlockedApp();
  updateModeChrome();
  await renderCard(false);
  localWhisper.warmup();
}

async function initAuthGate(): Promise<void> {
  authForm!.addEventListener('submit', (event: SubmitEvent) => {
    event.preventDefault();
    const password = authPasswordInput!.value;
    if (!password) {
      return;
    }

    authSubmitBtn!.disabled = true;
    authErrorBox!.classList.add('hidden');

    void unlockWithPassword(password)
      .then((session) => bootstrapApp(session))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Kunne ikke logge inn.';
        authErrorBox!.textContent = msg;
        authErrorBox!.classList.remove('hidden');
        authPasswordInput!.select();
      })
      .finally(() => {
        authSubmitBtn!.disabled = false;
      });
  });

  try {
    const session = await checkAuthSession();
    if (session.authenticated) {
      await bootstrapApp(session);
    } else {
      showLockedGate();
    }
  } catch (err: unknown) {
    const msg =
      err instanceof Error
        ? err.message
        : 'Innloggingstjenesten er ikke tilgjengelig.';
    showLockedGate(msg);
  }
}

void initAuthGate();
