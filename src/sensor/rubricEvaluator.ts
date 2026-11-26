import rawLexicon from '../data/connectorLexicon.json';
import type { CardContent } from '../types/card.ts';
import type {
  FillerCount,
  SensorBandLabel,
  SensorEvaluation,
  SensorPrompt,
} from '../types/sensor.ts';

const CONNECTOR_LEXICON: readonly CardContent[] = rawLexicon;

const GENERAL_CONNECTORS: readonly string[] = [
  'fordi',
  'derfor',
  'selv om',
  'dessuten',
  'likevel',
  'imidlertid',
  'derimot',
  'ettersom',
  'samtidig',
  'for eksempel',
  'på den ene siden',
  'på den andre siden',
  'for det første',
  'for det andre',
  'til slutt',
  'først',
  'deretter',
  'etterpå',
  'men',
  'også',
];

const SUBORDINATE_MARKERS: readonly string[] = [
  'at',
  'som',
  'hvis',
  'når',
  'mens',
  'fordi',
  'selv om',
  'ettersom',
  'dersom',
];

const FILLER_PHRASES: readonly string[] = [
  'på en måte',
  'ikke sant',
  'liksom',
  'altså',
  'eh',
  'øh',
  'ehm',
];

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countPhraseMatches(normalizedText: string, phrase: string): number {
  const pattern = new RegExp(`(^|[^\\p{L}])${escapeRegExp(phrase)}($|[^\\p{L}])`, 'giu');
  const matches = normalizedText.match(pattern);
  return matches ? matches.length : 0;
}

function tokenizeWords(transcript: string): string[] {
  const cleaned = transcript
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .trim();
  if (!cleaned) {
    return [];
  }
  return cleaned.split(/\s+/).filter((w) => w.length > 0);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function computeDurationScore(durationSeconds: number): number {
  if (durationSeconds >= 90 && durationSeconds <= 125) {
    return 100;
  }
  if (durationSeconds < 90) {
    return clampScore((durationSeconds / 90) * 85);
  }
  return clampScore(100 - (durationSeconds - 125) * 1.5);
}

function computeWpmScore(wpm: number, level: SensorPrompt['level']): number {
  const idealMin = level === 'A2' ? 65 : 85;
  const idealMax = level === 'A2' ? 125 : 150;
  if (wpm >= idealMin && wpm <= idealMax) {
    return 100;
  }
  if (wpm < idealMin) {
    return clampScore((wpm / idealMin) * 85);
  }
  return clampScore(100 - (wpm - idealMax) * 1.2);
}

export function evaluateSensorResponse(
  prompt: SensorPrompt,
  transcript: string,
  durationMs: number,
): SensorEvaluation {
  const normalized = transcript.toLowerCase().trim();
  const words = tokenizeWords(transcript);
  const wordCount = words.length;
  const uniqueWordCount = new Set(words).size;
  const durationSeconds = Math.max(1, Math.round(durationMs / 1000));
  const wpm = Math.round(wordCount / Math.max(durationMs / 60_000, 1 / 60));
  const lexicalDiversityPct =
    wordCount > 0 ? Math.round((uniqueWordCount / wordCount) * 100) : 0;

  const sentences = transcript
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const sentenceCount = Math.max(wordCount > 0 ? 1 : 0, sentences.length);

  const connectorPool = Array.from(
    new Set([...prompt.targetConnectors, ...GENERAL_CONNECTORS]),
  );
  const connectorsUsed = connectorPool.filter((c) => countPhraseMatches(normalized, c) > 0);
  const connectorsMissed = prompt.targetConnectors.filter(
    (c) => countPhraseMatches(normalized, c) === 0,
  );

  const subordinateMarkersUsed = SUBORDINATE_MARKERS.filter(
    (m) => countPhraseMatches(normalized, m) > 0,
  );

  const topicKeywordsMatched = prompt.topicKeywords.filter((kw) =>
    normalized.includes(kw.toLowerCase()),
  );

  const fillersDetected: FillerCount[] = [];
  let totalFillers = 0;
  for (const filler of FILLER_PHRASES) {
    const count = countPhraseMatches(normalized, filler);
    if (count > 0) {
      fillersDetected.push({ word: filler, count });
      totalFillers += count;
    }
  }

  const durationScore = computeDurationScore(durationSeconds);
  const wpmScore = computeWpmScore(wpm, prompt.level);
  const pacingScore = clampScore(durationScore * 0.6 + wpmScore * 0.4);

  const targetConnectorRatio =
    prompt.targetConnectors.length > 0
      ? (prompt.targetConnectors.length - connectorsMissed.length) /
        prompt.targetConnectors.length
      : 0;
  const subordinateRatio = Math.min(1, subordinateMarkersUsed.length / 3);
  const topicRatio =
    prompt.topicKeywords.length > 0
      ? Math.min(1, topicKeywordsMatched.length / Math.min(4, prompt.topicKeywords.length))
      : 0;

  const cohesionScore = clampScore(
    targetConnectorRatio * 45 + subordinateRatio * 30 + topicRatio * 25,
  );

  const fillerPenalty = wordCount > 0 ? Math.min(15, (totalFillers / wordCount) * 120) : 0;
  const overallScore = clampScore(pacingScore * 0.45 + cohesionScore * 0.55 - fillerPenalty);

  let bandEstimate: SensorBandLabel;
  if (durationSeconds < 35 || wordCount < 25 || overallScore < 40) {
    bandEstimate = 'Trenger litt mer lengde';
  } else if (overallScore < 62) {
    bandEstimate = 'A2 – god start';
  } else if (overallScore < 80) {
    bandEstimate = 'B1 – stødig';
  } else {
    bandEstimate = 'B2 – veldig bra';
  }

  const strengths: string[] = [];
  const improvements: string[] = [];

  if (durationSeconds >= 90 && durationSeconds <= 125) {
    strengths.push(`Perfekt taletid (${durationSeconds} sekunder) – rett i målet på 1,5–2 minutter.`);
  } else if (durationSeconds < 90) {
    improvements.push(
      `Du snakket i ${durationSeconds} sekunder. Prøv å utdype litt mer med et eksempel så du når 1,5–2 minutter.`,
    );
  } else {
    improvements.push(
      `Svaret varte i ${durationSeconds} sekunder. Øv på å avrunde før 2 minutter.`,
    );
  }

  if (connectorsUsed.length >= 3) {
    strengths.push(
      `Fint bruk av bindeord (${connectorsUsed.slice(0, 4).join(', ')}).`,
    );
  } else {
    improvements.push(
      `Bruk gjerne flere bindeord som ${connectorsMissed.slice(0, 3).join(', ') || 'fordi, derfor, selv om'} for bedre flyt.`,
    );
  }

  if (subordinateMarkersUsed.length >= 2) {
    strengths.push(
      `Gode leddsetninger med ${subordinateMarkersUsed.slice(0, 4).join(', ')}.`,
    );
  } else {
    improvements.push('Prøv å lage lengre setninger med «at», «som» eller «fordi».');
  }

  if (topicKeywordsMatched.length >= 2) {
    strengths.push(
      `Relevant ordforråd til temaet (${topicKeywordsMatched.slice(0, 4).join(', ')}).`,
    );
  } else {
    improvements.push(
      `Ta gjerne med flere temaord som ${prompt.topicKeywords.slice(0, 3).join(', ')}.`,
    );
  }

  if (totalFillers > 3) {
    improvements.push(
      `Du brukte ${totalFillers} fyllord (${fillersDetected.map((f) => `«${f.word}»`).join(', ')}). Ta heller en kort, rolig pause.`,
    );
  }

  const suggestedCards: CardContent[] = [];
  for (const missed of connectorsMissed) {
    const match = CONNECTOR_LEXICON.find(
      (entry) => entry.word.toLowerCase() === missed.toLowerCase(),
    );
    if (match) {
      suggestedCards.push(match);
    }
    if (suggestedCards.length >= 3) {
      break;
    }
  }

  if (suggestedCards.length === 0) {
    for (const entry of CONNECTOR_LEXICON) {
      if (!connectorsUsed.includes(entry.word.toLowerCase())) {
        suggestedCards.push(entry);
      }
      if (suggestedCards.length >= 2) {
        break;
      }
    }
  }

  return {
    durationSeconds,
    wordCount,
    uniqueWordCount,
    wpm,
    lexicalDiversityPct,
    sentenceCount,
    connectorsUsed,
    connectorsMissed,
    subordinateMarkersUsed,
    topicKeywordsMatched,
    fillersDetected,
    totalFillers,
    pacingScore,
    cohesionScore,
    overallScore,
    bandEstimate,
    strengths,
    improvements,
    suggestedCards,
  };
}
