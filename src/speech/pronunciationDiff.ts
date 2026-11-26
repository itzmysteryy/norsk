import { diffChars, type Change } from 'diff';

export interface DiffSegment {
  readonly text: string;
  readonly kind: 'match' | 'mismatch' | 'missing';
}

export interface PronunciationEvaluation {
  readonly targetWord: string;
  readonly rawTranscript: string;
  readonly normalizedTranscript: string;
  readonly segments: readonly DiffSegment[];
  readonly accuracyPercent: number;
  readonly diagnosticTip: string | null;
}

export function normalizeNorwegianUtterance(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replaceAll(/[.,!?;:"'«»()[\]{}]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function detectNorwegianPhoneticTip(target: string, spoken: string): string | null {
  if (!spoken) {
    return null;
  }

  if (target === spoken) {
    return 'Helt riktig uttale!';
  }

  if (target.includes('kj') && (spoken.includes('skj') || spoken.includes('sj') || spoken.includes('sh'))) {
    return 'Jeg hørte «skj/sj» i stedet for «kj». Hold tungespissen nede bak fortennene.';
  }

  if ((target.includes('skj') || target.includes('sj')) && (spoken.includes('kj') || spoken.startsWith('s'))) {
    return '«skj» skal ha en rund, tilbaketrukket «sj»-lyd, ikke «kj» eller vanlig «s».';
  }

  if (target.includes('gj') && !spoken.includes('gj') && (spoken.includes('g') || spoken.includes('j'))) {
    return 'I «gj-» foran ø, e, i eller y er «g» stum – begynn rett på «j»-lyden.';
  }

  if (target.includes('æ') && !spoken.includes('æ') && (spoken.includes('e') || spoken.includes('a'))) {
    return 'Åpne munnen litt mer for «æ» enn for «e» eller «a».';
  }

  if (target.includes('ø') && !spoken.includes('ø') && (spoken.includes('o') || spoken.includes('u'))) {
    return 'Rund leppene godt for «ø» i stedet for «o» eller «u».';
  }

  if (target.includes('å') && !spoken.includes('å') && (spoken.includes('a') || spoken.includes('o'))) {
    return 'Rund leppene for «å» så det ikke høres ut som «a».';
  }

  return 'Se på de røde bokstavene og prøv ordet én gang til.';
}

export function evaluatePronunciation(
  targetWord: string,
  rawTranscript: string,
): PronunciationEvaluation {
  const normalizedTarget = normalizeNorwegianUtterance(targetWord);
  const normalizedTranscript = normalizeNorwegianUtterance(rawTranscript);

  const changes: Change[] = diffChars(normalizedTarget, normalizedTranscript, {
    ignoreCase: true,
  });

  let matchedChars = 0;
  const segments: DiffSegment[] = changes.map((part) => {
    if (part.added) {
      return { text: part.value, kind: 'mismatch' };
    }
    if (part.removed) {
      return { text: part.value, kind: 'missing' };
    }
    matchedChars += part.value.length;
    return { text: part.value, kind: 'match' };
  });

  const denom = Math.max(normalizedTarget.length, normalizedTranscript.length, 1);
  const accuracyPercent = Math.round((matchedChars / denom) * 100);
  const diagnosticTip = detectNorwegianPhoneticTip(normalizedTarget, normalizedTranscript);

  return {
    targetWord,
    rawTranscript,
    normalizedTranscript,
    segments,
    accuracyPercent,
    diagnosticTip,
  };
}
