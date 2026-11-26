import type { CardContent } from './card.ts';

export type CefrLevel = 'A2' | 'B1' | 'B2';

export type AppMode = 'srs' | 'sensor';

export type EvaluatorProvider = 'groq' | 'local-ai' | 'rubric';

export type SpeakingTarget = 'prompt' | 'feedback' | 'followup' | null;

export interface SensorPrompt {
  readonly id: string;
  readonly level: CefrLevel;
  readonly taskType?: string;
  readonly topic: string;
  readonly promptNb: string;
  readonly promptEnHint: string;
  readonly followUpNb: string;
  readonly targetConnectors: readonly string[];
  readonly topicKeywords: readonly string[];
  readonly isAiGenerated?: boolean;
}

export type SensorRecordingPhase =
  | 'ready'
  | 'recording'
  | 'transcribing'
  | 'evaluated'
  | 'error';

export interface FillerCount {
  readonly word: string;
  readonly count: number;
}

export interface AiCorrection {
  readonly original: string;
  readonly corrected: string;
  readonly note: string;
}

export interface AiSensorCritique {
  readonly examinerComment: string;
  readonly corrections: readonly AiCorrection[];
  readonly followUpNb: string;
  readonly device: 'groq' | 'webgpu' | 'wasm';
  readonly modelLabel?: string;
  readonly bandEstimate?: string;
  readonly grammarScore?: number;
  readonly relevanceScore?: number;
}

export type AiEngineStatus =
  | { readonly phase: 'disabled' }
  | { readonly phase: 'loading'; readonly progress: number | null }
  | { readonly phase: 'ready'; readonly device: 'webgpu' | 'wasm' }
  | { readonly phase: 'running'; readonly device: 'webgpu' | 'wasm' }
  | { readonly phase: 'error'; readonly message: string };

export type SensorBandLabel =
  | 'Trenger litt mer lengde'
  | 'A2 – god start'
  | 'B1 – stødig'
  | 'B2 – veldig bra';

export interface SensorEvaluation {
  readonly durationSeconds: number;
  readonly wordCount: number;
  readonly uniqueWordCount: number;
  readonly wpm: number;
  readonly lexicalDiversityPct: number;
  readonly sentenceCount: number;
  readonly connectorsUsed: readonly string[];
  readonly connectorsMissed: readonly string[];
  readonly subordinateMarkersUsed: readonly string[];
  readonly topicKeywordsMatched: readonly string[];
  readonly fillersDetected: readonly FillerCount[];
  readonly totalFillers: number;
  readonly pacingScore: number;
  readonly cohesionScore: number;
  readonly overallScore: number;
  readonly bandEstimate: SensorBandLabel;
  readonly strengths: readonly string[];
  readonly improvements: readonly string[];
  readonly suggestedCards: readonly CardContent[];
}

export interface SensorAttempt {
  readonly id: string;
  readonly promptId: string;
  readonly level: CefrLevel;
  readonly topic: string;
  readonly promptNb: string;
  readonly transcript: string;
  readonly durationMs: number;
  readonly evaluation: SensorEvaluation;
  readonly aiCritique?: AiSensorCritique;
  readonly createdAt: number;
}

export interface SensorRuntimeState {
  readonly selectedLevel: CefrLevel;
  readonly promptIndexByLevel: Record<CefrLevel, number>;
  readonly phase: SensorRecordingPhase;
  readonly elapsedMs: number;
  readonly lastDurationMs: number;
  readonly transcript: string;
  readonly evaluation: SensorEvaluation | null;
  readonly evaluatorProvider: EvaluatorProvider;
  readonly groqConfigured: boolean;
  readonly fishAudioConfigured: boolean;
  readonly autoSpeakFeedback: boolean;
  readonly groqLoading: boolean;
  readonly aiCritique: AiSensorCritique | null;
  readonly aiErrorMessage: string | null;
  readonly aiStatus: AiEngineStatus;
  readonly webGpuAvailable: boolean;
  readonly history: readonly SensorAttempt[];
  readonly addedCardIds: readonly string[];
  readonly errorMessage: string | null;
  readonly showHint: boolean;
  readonly showFollowUp: boolean;
  readonly showSettings: boolean;
  readonly showPromptList: boolean;
  readonly customPrompts: readonly SensorPrompt[];
  readonly generatingPrompts: boolean;
  readonly promptGenError: string | null;
  readonly speakingTarget: SpeakingTarget;
  readonly ttsStatusMessage: string | null;
}
