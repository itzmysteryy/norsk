import type { DefaultSchedulerCard, Grade } from 'ts-fsrs';

export interface CardContent {
  readonly id: string;
  readonly word: string;
  readonly ipa: string;
  readonly partOfSpeech: string;
  readonly english: string;
  readonly exampleNb: string;
  readonly exampleEn: string;
  readonly phoneticTip: string;
}

export interface StoredSrsCard {
  readonly order: number;
  readonly content: CardContent;
  readonly fsrs: DefaultSchedulerCard;
}

export interface RatingOption {
  readonly grade: Grade;
  readonly keyHint: string;
  readonly label: 'Igjen' | 'Vanskelig' | 'Bra' | 'Lett';
  readonly accentClass: string;
}

export const RATING_OPTIONS: readonly RatingOption[] = [
  {
    grade: 1,
    keyHint: '1',
    label: 'Igjen',
    accentClass:
      'hover:border-rose-400/50 hover:bg-rose-500/10 focus-visible:ring-rose-400/50 text-rose-200',
  },
  {
    grade: 2,
    keyHint: '2',
    label: 'Vanskelig',
    accentClass:
      'hover:border-amber-400/50 hover:bg-amber-500/10 focus-visible:ring-amber-400/50 text-amber-200',
  },
  {
    grade: 3,
    keyHint: '3',
    label: 'Bra',
    accentClass:
      'hover:border-[#a3bd6f]/60 hover:bg-[#849e52]/15 focus-visible:ring-[#a3bd6f]/50 text-[#d2e4ab]',
  },
  {
    grade: 4,
    keyHint: '4',
    label: 'Lett',
    accentClass:
      'hover:border-emerald-400/50 hover:bg-emerald-500/10 focus-visible:ring-emerald-400/50 text-emerald-200',
  },
] as const;

export type IntervalPreviewMap = Readonly<Record<Grade, string>>;

export interface DeckMetrics {
  readonly totalCount: number;
  readonly dueCount: number;
  readonly overdueCount: number;
  readonly newCount: number;
  readonly learningCount: number;
  readonly reviewCount: number;
  readonly nextDueAt: Date | null;
}
