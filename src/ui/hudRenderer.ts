import type { Grade } from 'ts-fsrs';
import type { ModelStatus } from '../speech/localWhisperProvider.ts';
import type { PronunciationEvaluation } from '../speech/pronunciationDiff.ts';
import { formatIntervalDuration, getStateLabel } from '../srs/fsrsEngine.ts';
import {
  RATING_OPTIONS,
  type DeckMetrics,
  type IntervalPreviewMap,
  type StoredSrsCard,
} from '../types/card.ts';

export type SpeechPanelState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'listening'; readonly interim: string }
  | { readonly kind: 'processing' }
  | { readonly kind: 'graded'; readonly evaluation: PronunciationEvaluation }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'unsupported'; readonly message: string };

export interface HudRenderParams {
  readonly activeCard: StoredSrsCard | null;
  readonly isFlipped: boolean;
  readonly isBusy: boolean;
  readonly isSpeakingWord: boolean;
  readonly intervals: IntervalPreviewMap | null;
  readonly metrics: DeckMetrics;
  readonly speechState: SpeechPanelState;
  readonly modelStatus: ModelStatus;
}

export interface HudActions {
  readonly onFlip: () => void;
  readonly onRate: (grade: Grade) => void;
  readonly onReset: () => void;
  readonly onSpeakWord: () => void;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDueCounter(metrics: DeckMetrics): string {
  const due = String(metrics.dueCount).padStart(2, '0');
  const total = String(metrics.totalCount).padStart(2, '0');
  return `${due} / ${total}`;
}

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) {
    throw new Error(`Required HUD element not found: ${selector}`);
  }
  return el;
}

function renderModelStatusPill(pill: HTMLElement, status: ModelStatus): void {
  switch (status.phase) {
    case 'idle':
      pill.textContent = 'Klargjør tale...';
      pill.className =
        'rounded-full border border-slate-700/70 bg-slate-950/70 px-2 py-0.5 text-[11px] text-slate-400';
      break;
    case 'loading':
      pill.textContent =
        status.progress !== null ? `Laster tale ${status.progress}%` : 'Laster tale...';
      pill.className =
        'rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300';
      break;
    case 'ready':
      pill.textContent = 'Tale klar';
      pill.className =
        'rounded-full border border-[#849e52]/50 bg-[#1e2614]/80 px-2 py-0.5 text-[11px] text-[#bfd591]';
      break;
    case 'error':
      pill.textContent = 'Talefeil';
      pill.className =
        'rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-400';
      break;
  }
}

function renderSpeechFeedback(
  container: HTMLElement,
  button: HTMLButtonElement,
  indicator: HTMLElement,
  buttonLabel: HTMLElement,
  speechState: SpeechPanelState,
  modelStatus: ModelStatus,
  hasActiveCard: boolean,
): void {
  const isUnsupported = speechState.kind === 'unsupported';
  const isListening = speechState.kind === 'listening';
  const isProcessing = speechState.kind === 'processing';

  button.disabled = !hasActiveCard || isUnsupported || isProcessing;
  button.setAttribute('aria-pressed', String(isListening));

  if (isListening) {
    button.classList.add('border-rose-400/70', 'bg-rose-500/20', 'text-rose-100');
    button.classList.remove('border-[#849e52]/45', 'bg-[#1e2614]/65', 'text-[#d2e4ab]');
    indicator.className =
      'h-2 w-2 rounded-full bg-rose-400 shadow-[0_0_10px_rgba(251,113,133,0.9)] animate-pulse';
    buttonLabel.textContent = 'Lytter... Slipp når ferdig';
  } else if (isProcessing) {
    button.classList.remove('border-rose-400/70', 'bg-rose-500/20', 'text-rose-100');
    button.classList.add('border-[#849e52]/45', 'bg-[#1e2614]/65', 'text-[#d2e4ab]');
    indicator.className = 'h-2 w-2 rounded-full bg-amber-300 animate-pulse';
    buttonLabel.textContent =
      modelStatus.phase === 'loading' && modelStatus.progress !== null
        ? `Laster stemmegjenkjenning ${modelStatus.progress}%...`
        : 'Sjekker uttalen...';
  } else {
    button.classList.remove('border-rose-400/70', 'bg-rose-500/20', 'text-rose-100');
    button.classList.add('border-[#849e52]/45', 'bg-[#1e2614]/65', 'text-[#d2e4ab]');
    indicator.className = isUnsupported
      ? 'h-2 w-2 rounded-full bg-red-500'
      : 'h-2 w-2 rounded-full bg-[#a3bd6f] transition';
    buttonLabel.textContent = isUnsupported ? 'Mikrofon utilgjengelig' : 'Hold og snakk';
  }

  switch (speechState.kind) {
    case 'idle': {
      const modelHint =
        modelStatus.phase === 'loading'
          ? ` <span class="text-amber-300">(${modelStatus.progress !== null ? `laster tale ${modelStatus.progress}%` : 'laster tale...'})</span>`
          : '';
      container.innerHTML = `
        Hold knappen inne og si ordet høyt på norsk${modelHint}
      `;
      break;
    }

    case 'listening':
      container.innerHTML = speechState.interim
        ? `<span class="text-slate-400">Hører:</span> <span class="text-slate-100">«${escapeHtml(speechState.interim)}»</span>`
        : `<span class="text-olive-400">Lytter nå... Slipp knappen når du er ferdig</span>`;
      break;

    case 'processing':
      container.innerHTML =
        modelStatus.phase === 'loading'
          ? `<span class="text-amber-300">Klargjør norsk talegjenkjenning (${modelStatus.progress ?? 0}%)...</span>`
          : `<span class="text-olive-400">Sjekker uttalen din...</span>`;
      break;

    case 'graded': {
      const { evaluation } = speechState;
      const diffHtml = evaluation.segments
        .map((segment) => {
          const safe = escapeHtml(segment.text);
          if (segment.kind === 'match') {
            return `<span class="text-olive-400 font-semibold">${safe}</span>`;
          }
          if (segment.kind === 'missing') {
            return `<span class="rounded bg-red-500/10 px-0.5 text-red-500 line-through opacity-80" title="Bokstav som manglet">${safe}</span>`;
          }
          return `<span class="rounded bg-red-500/15 px-0.5 text-red-500 font-semibold" title="Annen lyd hørt">${safe}</span>`;
        })
        .join('');

      const badgeColor =
        evaluation.accuracyPercent === 100 ? 'text-olive-400' : 'text-red-400';

      const tipHtml = evaluation.diagnosticTip
        ? `<div class="mt-1 rounded-md border border-slate-800/90 bg-slate-900/70 px-3 py-1.5 text-xs leading-snug text-slate-300" data-testid="phonetic-diagnostic">${escapeHtml(evaluation.diagnosticTip)}</div>`
        : '';

      container.innerHTML = `
        <div class="flex flex-col items-center gap-1.5">
          <div class="text-xl tracking-wide font-mono" data-testid="diff-output">${diffHtml}</div>
          <div class="flex flex-wrap items-center justify-center gap-3 text-xs text-slate-400">
            <span>Mål: <span class="text-slate-200">${escapeHtml(evaluation.targetWord)}</span></span>
            <span>Hørte: <span class="text-slate-200">«${escapeHtml(evaluation.rawTranscript)}»</span></span>
            <span class="${badgeColor} font-semibold">${evaluation.accuracyPercent}% likt</span>
          </div>
          ${tipHtml}
        </div>
      `;
      break;
    }

    case 'error':
      container.innerHTML = `
        <span class="text-red-400" data-testid="speech-error">${escapeHtml(speechState.message)}</span>
      `;
      break;

    case 'unsupported':
      container.innerHTML = `
        <span class="text-red-400" data-testid="speech-unsupported">${escapeHtml(speechState.message)}</span>
      `;
      break;
  }
}

function renderActionDock(
  dock: HTMLElement,
  activeCard: StoredSrsCard | null,
  isFlipped: boolean,
  isBusy: boolean,
  intervals: IntervalPreviewMap | null,
): void {
  const disabledAttr = isBusy ? 'disabled' : '';

  if (!activeCard) {
    dock.innerHTML = `
      <button
        type="button"
        data-action="reset"
        ${disabledAttr}
        class="group flex w-full cursor-pointer items-center justify-center gap-3 rounded-xl border border-[#849e52]/45 bg-[#1e2614]/70 px-5 py-3.5 text-sm font-medium text-[#d2e4ab] transition hover:border-[#a3bd6f] hover:bg-[#849e52]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a3bd6f]/60 disabled:cursor-wait disabled:opacity-50"
      >
        <span>Øv på kortene igjen</span>
      </button>
    `;
    return;
  }

  if (!isFlipped) {
    dock.innerHTML = `
      <button
        type="button"
        data-action="flip"
        ${disabledAttr}
        class="group flex w-full cursor-pointer items-center justify-center gap-3 rounded-xl border border-[#849e52]/45 bg-[#1e2614]/65 px-5 py-3.5 text-sm font-medium text-[#d2e4ab] transition hover:border-[#a3bd6f] hover:bg-[#849e52]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a3bd6f]/60 disabled:cursor-wait disabled:opacity-50"
      >
        <span>Vis svar</span>
        <kbd class="rounded border border-[#849e52]/50 bg-slate-950/80 px-2 py-0.5 font-mono text-[10px] text-[#bfd591]">SPACE</kbd>
      </button>
    `;
    return;
  }

  const buttons = RATING_OPTIONS.map((option) => {
    const intervalText = intervals ? intervals[option.grade] : '--';
    return `
      <button
        type="button"
        data-action="rate"
        data-grade="${option.grade}"
        ${disabledAttr}
        class="group flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-slate-700/55 bg-slate-900/70 px-3 py-3 transition focus-visible:outline-none focus-visible:ring-2 disabled:cursor-wait disabled:opacity-50 ${option.accentClass}"
      >
        <kbd class="rounded border border-slate-700/80 bg-slate-950/90 px-2 py-0.5 font-mono text-[11px] text-slate-300 transition group-hover:border-current/40">
          ${option.keyHint}
        </kbd>
        <span class="text-xs font-semibold tracking-wide">${option.label}</span>
        <span class="font-mono text-[10px] text-slate-400" data-testid="interval-${option.grade}">
          ${escapeHtml(intervalText)}
        </span>
      </button>
    `;
  }).join('');

  dock.innerHTML = `<div class="grid grid-cols-4 gap-2.5" data-testid="rating-grid">${buttons}</div>`;
}

export function renderHudView(params: HudRenderParams): void {
  const {
    activeCard,
    isFlipped,
    isBusy,
    isSpeakingWord,
    intervals,
    metrics,
    speechState,
    modelStatus,
  } = params;

  const deckCounter = requireElement<HTMLElement>('#deck-counter');
  const statusPill = requireElement<HTMLElement>('#whisper-status-pill');
  const progressBar = requireElement<HTMLElement>('#progress-bar');
  const activeCardView = requireElement<HTMLElement>('#active-card-view');
  const queueClearedView = requireElement<HTMLElement>('#queue-cleared-view');
  const actionDock = requireElement<HTMLElement>('#action-dock');

  deckCounter.textContent = formatDueCounter(metrics);
  renderModelStatusPill(statusPill, modelStatus);

  const completedCount = Math.max(0, metrics.totalCount - metrics.dueCount);
  const progressPct =
    metrics.totalCount === 0
      ? 100
      : Math.round(((completedCount + (activeCard && isFlipped ? 0.5 : 0)) / metrics.totalCount) * 100);
  progressBar.style.width = `${progressPct}%`;

  const holdBtn = requireElement<HTMLButtonElement>('#hold-to-speak-btn');
  const micIndicator = requireElement<HTMLElement>('#mic-indicator');
  const holdLabel = requireElement<HTMLElement>('#hold-to-speak-label');
  const diffContainer = requireElement<HTMLElement>('#pronunciation-diff');
  const listenWordBtn = requireElement<HTMLButtonElement>('#listen-word-btn');

  if (activeCard) {
    activeCardView.classList.remove('hidden');
    queueClearedView.classList.add('hidden');

    requireElement<HTMLElement>('#card-pos').textContent = activeCard.content.partOfSpeech;
    requireElement<HTMLElement>('#card-srs-state').textContent = getStateLabel(activeCard.fsrs.state);
    requireElement<HTMLElement>('#card-word').textContent = activeCard.content.word;
    requireElement<HTMLElement>('#card-ipa').textContent = activeCard.content.ipa;
    listenWordBtn.textContent = isSpeakingWord ? 'Stopp lyd' : 'Hør ordet';

    const frontHint = requireElement<HTMLElement>('#card-front-hint');
    const cardBack = requireElement<HTMLElement>('#card-back');

    if (isFlipped) {
      frontHint.classList.add('hidden');
      cardBack.classList.remove('hidden');
      requireElement<HTMLElement>('#card-english').textContent = activeCard.content.english;
      requireElement<HTMLElement>('#card-example-nb').textContent = activeCard.content.exampleNb;
      requireElement<HTMLElement>('#card-example-en').textContent = activeCard.content.exampleEn;
      requireElement<HTMLElement>('#card-phonetic-tip').textContent = activeCard.content.phoneticTip;
    } else {
      frontHint.classList.remove('hidden');
      cardBack.classList.add('hidden');
    }

    renderSpeechFeedback(
      diffContainer,
      holdBtn,
      micIndicator,
      holdLabel,
      speechState,
      modelStatus,
      true,
    );
  } else {
    activeCardView.classList.add('hidden');
    queueClearedView.classList.remove('hidden');

    const nextLabel = metrics.nextDueAt
      ? `${formatIntervalDuration(new Date(), metrics.nextDueAt)} (kl. ${metrics.nextDueAt.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })})`
      : 'senere';

    requireElement<HTMLElement>('#next-due-label').textContent = nextLabel;
    requireElement<HTMLElement>('#metric-new').textContent = String(metrics.newCount);
    requireElement<HTMLElement>('#metric-learning').textContent = String(metrics.learningCount);
    requireElement<HTMLElement>('#metric-review').textContent = String(metrics.reviewCount);

    renderSpeechFeedback(
      diffContainer,
      holdBtn,
      micIndicator,
      holdLabel,
      speechState,
      modelStatus,
      false,
    );
  }

  renderActionDock(actionDock, activeCard, isFlipped, isBusy, intervals);
}

export function bindHudClickActions(root: HTMLElement, actions: HudActions): () => void {
  const handleClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const button = target.closest<HTMLButtonElement>('button[data-action]');
    if (!button || button.disabled) {
      return;
    }

    const action = button.dataset.action;
    if (action === 'flip') {
      actions.onFlip();
      return;
    }
    if (action === 'reset') {
      actions.onReset();
      return;
    }
    if (action === 'speak-word') {
      actions.onSpeakWord();
      return;
    }
    if (action === 'rate') {
      const rawGrade = Number(button.dataset.grade);
      if (rawGrade === 1 || rawGrade === 2 || rawGrade === 3 || rawGrade === 4) {
        actions.onRate(rawGrade);
      }
    }
  };

  root.addEventListener('click', handleClick);
  return () => {
    root.removeEventListener('click', handleClick);
  };
}
