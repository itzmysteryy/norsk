import type { AiSensorCritique, CefrLevel, SensorPrompt } from '../types/sensor.ts';

export interface GroqEvaluationInput {
  readonly level: CefrLevel;
  readonly promptNb: string;
  readonly transcript: string;
  readonly durationSeconds: number;
}

export interface GroqGeneratePromptsInput {
  readonly level: CefrLevel;
  readonly existingPrompts: readonly string[];
  readonly count?: number;
}

export async function generateSimilarPromptsWithGroq(
  input: GroqGeneratePromptsInput,
): Promise<SensorPrompt[]> {
  const response = await fetch('/api/prompts', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    prompts?: SensorPrompt[];
  };

  if (!response.ok) {
    throw new Error(payload.error || `Kunne ikke lage nye spørsmål (${response.status}).`);
  }

  return Array.isArray(payload.prompts) ? payload.prompts : [];
}

export async function evaluateWithGroq(
  input: GroqEvaluationInput,
): Promise<AiSensorCritique> {
  const response = await fetch('/api/evaluate', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    examinerComment?: string;
    bandEstimate?: string;
    grammarScore?: number;
    relevanceScore?: number;
    corrections?: AiSensorCritique['corrections'];
    followUpNb?: string;
    model?: string;
  };

  if (!response.ok) {
    throw new Error(payload.error || `Groq evaluation failed (${response.status}).`);
  }

  return {
    examinerComment: payload.examinerComment || 'Evaluated by Groq Norsk Sensor.',
    bandEstimate: payload.bandEstimate,
    grammarScore: payload.grammarScore,
    relevanceScore: payload.relevanceScore,
    corrections: Array.isArray(payload.corrections) ? payload.corrections : [],
    followUpNb: payload.followUpNb || '',
    device: 'groq',
    modelLabel: payload.model || 'openai/gpt-oss-120b',
  };
}
