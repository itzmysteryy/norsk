import { createStore, get, set } from 'idb-keyval';
import type { DefaultSchedulerRevlog } from 'ts-fsrs';
import type { SrsEngine } from '../srs/fsrsEngine.ts';
import type { CardContent, StoredSrsCard } from '../types/card.ts';

const SRS_STORE = createStore('honest-norsk-db', 'srs-store');
const CARDS_KEY = 'honest-norsk:cards:v1';
const CUSTOM_CARDS_KEY = 'honest-norsk:custom-cards:v1';
const REVLOGS_KEY = 'honest-norsk:revlogs:v1';

function toValidDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function hydrateStoredCard(raw: StoredSrsCard): StoredSrsCard {
  return {
    ...raw,
    fsrs: {
      ...raw.fsrs,
      dueAt: toValidDate(raw.fsrs.dueAt),
      lastReviewAt: raw.fsrs.lastReviewAt ? toValidDate(raw.fsrs.lastReviewAt) : null,
    },
  };
}

export async function loadStoredCards(): Promise<StoredSrsCard[]> {
  const existing = await get<StoredSrsCard[]>(CARDS_KEY, SRS_STORE);
  if (!existing) {
    return [];
  }
  return existing.map(hydrateStoredCard);
}

export async function loadCustomSeedCards(): Promise<CardContent[]> {
  const custom = await get<CardContent[]>(CUSTOM_CARDS_KEY, SRS_STORE);
  return custom ? [...custom] : [];
}

export async function saveStoredCards(cards: readonly StoredSrsCard[]): Promise<void> {
  await set(CARDS_KEY, [...cards], SRS_STORE);
}

export async function appendReviewLog(revlog: DefaultSchedulerRevlog): Promise<void> {
  const existing = (await get<DefaultSchedulerRevlog[]>(REVLOGS_KEY, SRS_STORE)) ?? [];
  await set(REVLOGS_KEY, [...existing, revlog], SRS_STORE);
}

export async function initializeDeckStore(
  seedDeck: readonly CardContent[],
  engine: SrsEngine,
): Promise<StoredSrsCard[]> {
  const existing = await loadStoredCards();
  const customSeeds = await loadCustomSeedCards();
  const byId = new Map<string, StoredSrsCard>(existing.map((card) => [card.content.id, card]));
  const combinedSeed = [...seedDeck];

  for (const custom of customSeeds) {
    if (!combinedSeed.some((c) => c.id === custom.id)) {
      combinedSeed.push(custom);
    }
  }

  const now = new Date();
  let mutated = false;
  const merged: StoredSrsCard[] = combinedSeed.map((content, order) => {
    const found = byId.get(content.id);
    if (found) {
      return {
        order,
        content,
        fsrs: found.fsrs,
      };
    }

    mutated = true;
    return {
      order,
      content,
      fsrs: engine.createNewCard(content.id, now),
    };
  });

  if (existing.length === 0 || mutated || merged.length !== existing.length) {
    await saveStoredCards(merged);
  }

  return merged;
}

export async function addCardToDeck(
  content: CardContent,
  engine: SrsEngine,
): Promise<{ readonly added: boolean; readonly cards: StoredSrsCard[] }> {
  const existing = await loadStoredCards();
  if (existing.some((item) => item.content.id === content.id)) {
    return { added: false, cards: existing };
  }

  const customSeeds = await loadCustomSeedCards();
  if (!customSeeds.some((item) => item.id === content.id)) {
    await set(CUSTOM_CARDS_KEY, [...customSeeds, content], SRS_STORE);
  }

  const newCard: StoredSrsCard = {
    order: existing.length,
    content,
    fsrs: engine.createNewCard(content.id, new Date()),
  };
  const updated = [...existing, newCard];
  await saveStoredCards(updated);
  return { added: true, cards: updated };
}

export async function resetDeckStore(
  seedDeck: readonly CardContent[],
  engine: SrsEngine,
): Promise<StoredSrsCard[]> {
  const customSeeds = await loadCustomSeedCards();
  const combinedSeed = [...seedDeck];
  for (const custom of customSeeds) {
    if (!combinedSeed.some((c) => c.id === custom.id)) {
      combinedSeed.push(custom);
    }
  }

  const now = new Date();
  const freshCards: StoredSrsCard[] = combinedSeed.map((content, order) => ({
    order,
    content,
    fsrs: engine.createNewCard(content.id, now),
  }));

  await saveStoredCards(freshCards);
  await set(REVLOGS_KEY, [], SRS_STORE);
  return freshCards;
}
