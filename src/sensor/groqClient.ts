import type { AiSensorCritique, CefrLevel } from '../types/sensor.ts';

export interface GroqEvaluationInput {
  readonly level: CefrLevel;
  readonly promptNb: string;
  readonly transcript: string;
  readonly durationSeconds: number;
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
