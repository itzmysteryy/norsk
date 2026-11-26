import {
  DefaultScheduler,
  State,
  type DefaultScheduler as DefaultSchedulerInstance,
  type DefaultSchedulerCard,
  type DefaultSchedulerRevlog,
  type Grade,
} from 'ts-fsrs';
import type { DeckMetrics, IntervalPreviewMap, StoredSrsCard } from '../types/card.ts';

export interface SrsEngine {
  readonly createNewCard: (cardId: string, now?: Date) => DefaultSchedulerCard;
  readonly scheduleReview: (
    card: DefaultSchedulerCard,
    grade: Grade,
    now?: Date,
  ) => {
    readonly card: DefaultSchedulerCard;
    readonly revlog: DefaultSchedulerRevlog;
  };
  readonly previewIntervals: (card: DefaultSchedulerCard, now?: Date) => IntervalPreviewMap;
}

export function formatIntervalDuration(from: Date, to: Date): string {
  const diffMs = Math.max(0, to.getTime() - from.getTime());
  const totalMinutes = Math.round(diffMs / 60_000);

  if (totalMinutes < 1) {
    return '< 1m';
  }
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const totalHours = Math.round(diffMs / 3_600_000);
  if (totalHours < 24) {
    return `${totalHours}t`;
  }

  const totalDays = Math.round(diffMs / 86_400_000);
  if (totalDays < 30) {
    return `${totalDays}d`;
  }

  const totalMonths = Math.round(totalDays / 30);
  if (totalMonths < 12) {
    return `${totalMonths} mnd`;
  }

  const totalYears = (totalDays / 365).toFixed(1).replace(/\.0$/, '');
  return `${totalYears} år`;
}

export async function createSrsEngine(): Promise<SrsEngine> {
  const scheduler: DefaultSchedulerInstance<'FSRS-7'> = await DefaultScheduler({
    enableFuzz: true,
    enableShortTerm: true,
  });

  return {
    createNewCard: (cardId: string, now: Date = new Date()): DefaultSchedulerCard => {
      return scheduler.newCard({ now, cardId });
    },

    scheduleReview: (
      card: DefaultSchedulerCard,
      grade: Grade,
      now: Date = new Date(),
    ): {
      readonly card: DefaultSchedulerCard;
      readonly revlog: DefaultSchedulerRevlog;
    } => {
      const result = scheduler.review({ card, grade, now });
      return {
        card: result.card,
        revlog: result.revlog,
      };
    },

    previewIntervals: (card: DefaultSchedulerCard, now: Date = new Date()): IntervalPreviewMap => {
      const previews: Record<Grade, string> = {
        1: '< 1m',
        2: '< 1m',
        3: '< 1m',
        4: '< 1m',
      };

      for (const item of scheduler.preview({ card, now })) {
        previews[item.grade] = formatIntervalDuration(now, item.card.dueAt);
      }

      return previews;
    },
  };
}

export function selectNextCard(
  cards: readonly StoredSrsCard[],
  now: Date = new Date(),
): StoredSrsCard | null {
  const nowMs = now.getTime();

  const dueReviewed = cards
    .filter((item) => item.fsrs.state !== State.New && item.fsrs.dueAt.getTime() <= nowMs)
    .sort((a, b) => a.fsrs.dueAt.getTime() - b.fsrs.dueAt.getTime());

  if (dueReviewed.length > 0) {
    return dueReviewed[0] ?? null;
  }

  const newCards = cards
    .filter((item) => item.fsrs.state === State.New)
    .sort((a, b) => a.order - b.order);

  return newCards[0] ?? null;
}

export function computeMetrics(cards: readonly StoredSrsCard[], now: Date = new Date()): DeckMetrics {
  const nowMs = now.getTime();
  let overdueCount = 0;
  let newCount = 0;
  let learningCount = 0;
  let reviewCount = 0;
  let nextDueAt: Date | null = null;

  for (const item of cards) {
    const { state, dueAt } = item.fsrs;

    if (state === State.New) {
      newCount += 1;
    } else if (state === State.Learning || state === State.Relearning) {
      learningCount += 1;
    } else if (state === State.Review) {
      reviewCount += 1;
    }

    if (state !== State.New && dueAt.getTime() <= nowMs) {
      overdueCount += 1;
    }

    if (state !== State.New && dueAt.getTime() > nowMs) {
      if (nextDueAt === null || dueAt.getTime() < nextDueAt.getTime()) {
        nextDueAt = dueAt;
      }
    }
  }

  return {
    totalCount: cards.length,
    dueCount: overdueCount + newCount,
    overdueCount,
    newCount,
    learningCount,
    reviewCount,
    nextDueAt,
  };
}

export function getStateLabel(state: DefaultSchedulerCard['state']): string {
  switch (state) {
    case State.New:
      return 'Nytt ord';
    case State.Learning:
      return 'Øves';
    case State.Review:
      return 'Kan godt';
    case State.Relearning:
      return 'Repeteres';
    default:
      return 'Ukjent';
  }
}
