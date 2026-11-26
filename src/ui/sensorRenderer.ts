import type { ModelStatus } from '../speech/localWhisperProvider.ts';
import type { CardContent } from '../types/card.ts';
import type {
  AiEngineStatus,
  AiSensorCritique,
  CefrLevel,
  EvaluatorProvider,
  SensorAttempt,
  SensorEvaluation,
  SensorPrompt,
  SensorRuntimeState,
} from '../types/sensor.ts';

export const SENSOR_TARGET_MIN_MS = 90_000;
export const SENSOR_TARGET_MAX_MS = 120_000;
export const SENSOR_HARD_CAP_MS = 135_000;

export interface SensorRenderParams {
  readonly prompt: SensorPrompt;
  readonly promptPosition: { readonly current: number; readonly total: number };
  readonly state: SensorRuntimeState;
  readonly modelStatus: ModelStatus;
  readonly micUnsupportedReason: string | null;
}

export interface SensorActions {
  readonly onSelectLevel: (level: CefrLevel) => void;
  readonly onSelectEvaluator: (provider: EvaluatorProvider) => void;
  readonly onNextPrompt: () => void;
  readonly onToggleHint: () => void;
  readonly onToggleSettings: () => void;
  readonly onToggleAutoSpeak: () => void;
  readonly onSpeakPrompt: () => void;
  readonly onSpeakFeedback: (text: string) => void;
  readonly onSpeakFollowUp: (text: string) => void;
  readonly onToggleFollowUp: () => void;
  readonly onToggleRecording: () => void;
  readonly onEnableAiSensor: () => void;
  readonly onRunAiCritique: () => void;
  readonly onAddCardToDeck: (card: CardContent) => void;
  readonly onClearHistory: () => void;
}

const LEVELS: readonly CefrLevel[] = ['A2', 'B1', 'B2'];

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatStopwatch(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getZoneDescriptor(
  elapsedMs: number,
  phase: SensorRuntimeState['phase'],
): { readonly label: string; readonly badgeClass: string; readonly barClass: string } {
  if (phase === 'ready' && elapsedMs === 0) {
    return {
      label: 'Klar · mål 1:30–2:00',
      badgeClass: 'border-slate-700/70 bg-slate-950/70 text-slate-400',
      barClass: 'bg-slate-600',
    };
  }
  if (elapsedMs < SENSOR_TARGET_MIN_MS) {
    return {
      label: 'Snakk videre (< 1:30)',
      badgeClass: 'border-amber-500/35 bg-amber-500/10 text-amber-300',
      barClass: 'bg-amber-400',
    };
  }
  if (elapsedMs <= SENSOR_TARGET_MAX_MS) {
    return {
      label: 'Perfekt tid (1:30–2:00)',
      badgeClass: 'border-[#849e52]/55 bg-[#1e2614]/80 text-[#bfd591]',
      barClass: 'bg-[#a3bd6f]',
    };
  }
  return {
    label: 'Avslutt snart (> 2:00)',
    badgeClass: 'border-rose-500/45 bg-rose-500/10 text-rose-300',
    barClass: 'bg-rose-400',
  };
}

function getBandBadgeClass(band: SensorEvaluation['bandEstimate']): string {
  switch (band) {
    case 'B2 – veldig bra':
      return 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200';
    case 'B1 – stødig':
      return 'border-[#849e52]/60 bg-[#1e2614]/80 text-[#d2e4ab]';
    case 'A2 – god start':
      return 'border-amber-400/45 bg-amber-500/15 text-amber-200';
    case 'Trenger litt mer lengde':
      return 'border-rose-400/45 bg-rose-500/15 text-rose-200';
  }
}

export function buildSpokenFeedbackText(
  evaluation: SensorEvaluation,
  critique: AiSensorCritique | null,
): string {
  if (critique) {
    const parts = [critique.examinerComment];
    if (critique.corrections[0]) {
      parts.push(
        `Tips: I stedet for «${critique.corrections[0].original}», kan du si «${critique.corrections[0].corrected}».`,
      );
    }
    if (critique.followUpNb) {
      parts.push(`Oppfølgingsspørsmål: ${critique.followUpNb}`);
    }
    return parts.join(' ');
  }

  const strength = evaluation.strengths[0] ?? 'Bra innsats.';
  const tip = evaluation.improvements[0] ?? '';
  return `${evaluation.bandEstimate}. ${strength} ${tip}`.trim();
}

export function updateSensorStopwatchDom(
  elapsedMs: number,
  phase: SensorRuntimeState['phase'],
): void {
  const clockEl = document.querySelector<HTMLElement>('#sensor-stopwatch');
  const zoneEl = document.querySelector<HTMLElement>('#sensor-zone-badge');
  const fillEl = document.querySelector<HTMLElement>('#sensor-stopwatch-fill');
  if (!clockEl || !zoneEl || !fillEl) {
    return;
  }

  clockEl.textContent = formatStopwatch(elapsedMs);
  const zone = getZoneDescriptor(elapsedMs, phase);
  zoneEl.textContent = zone.label;
  zoneEl.className = `rounded-full border px-2.5 py-0.5 text-xs ${zone.badgeClass}`;

  const pct = Math.min(100, Math.round((elapsedMs / SENSOR_HARD_CAP_MS) * 100));
  fillEl.style.width = `${pct}%`;
  fillEl.className = `relative h-full rounded-full transition-all duration-150 ${zone.barClass}`;
}

function renderSettingsPanel(
  provider: EvaluatorProvider,
  groqConfigured: boolean,
  fishAudioConfigured: boolean,
  autoSpeakFeedback: boolean,
  aiStatus: AiEngineStatus,
  disabled: boolean,
): string {
  const options: ReadonlyArray<{ readonly id: EvaluatorProvider; readonly label: string }> = [
    { id: 'groq', label: 'Smart sensor' },
    { id: 'local-ai', label: 'Lokal AI' },
    { id: 'rubric', label: 'Enkel sjekk' },
  ];

  const tabsHtml = options
    .map((opt) => {
      const active = opt.id === provider;
      return `
        <button
          type="button"
          data-sensor-action="select-evaluator"
          data-provider="${opt.id}"
          data-testid="evaluator-tab-${opt.id}"
          ${disabled ? 'disabled' : ''}
          class="cursor-pointer rounded-md px-2.5 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-50 ${
            active
              ? 'border border-[#849e52]/50 bg-[#1e2614] text-[#d2e4ab]'
              : 'border border-transparent text-slate-400 hover:text-slate-200'
          }"
        >
          ${opt.label}
        </button>
      `;
    })
    .join('');

  let detailHtml = '';
  if (provider === 'groq') {
    detailHtml = groqConfigured
      ? 'Smart sensor gir deg grundige rettelser på norsk.'
      : 'Legg inn GROQ_API_KEY i .env for smart vurdering (ellers brukes enkel sjekk).';
  } else if (provider === 'local-ai') {
    if (aiStatus.phase === 'disabled') {
      detailHtml = `
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span>Lokal AI kjører rett i nettleseren (laster ned ca. 485 MB).</span>
          <button
            type="button"
            data-sensor-action="enable-ai"
            data-testid="enable-ai-sensor-btn"
            class="cursor-pointer rounded border border-[#849e52]/45 bg-[#1e2614]/70 px-2.5 py-1 text-xs text-[#d2e4ab] hover:border-[#a3bd6f]"
          >
            Last inn lokal AI
          </button>
        </div>
      `;
    } else if (aiStatus.phase === 'loading') {
      detailHtml = `Laster inn lokal AI (${aiStatus.progress ?? 0}%)...`;
    } else if (aiStatus.phase === 'ready' || aiStatus.phase === 'running') {
      detailHtml = 'Lokal AI er klar.';
    } else {
      detailHtml = escapeHtml(aiStatus.message);
    }
  } else {
    detailHtml = 'Rask sjekk av lengde, tempo og bindeord uten internett.';
  }

  return `
    <div class="flex flex-col gap-3 rounded-xl border border-slate-800/90 bg-slate-900/55 p-4 text-xs animate-panel-reveal" data-testid="ai-sensor-bar">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-medium text-slate-300">Vurdering</span>
        <div class="inline-flex rounded-lg border border-slate-800 bg-slate-950/80 p-0.5">
          ${tabsHtml}
        </div>
      </div>

      <div class="text-slate-400">${detailHtml}</div>

      <div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-2.5">
        <div>
          <span class="font-medium text-slate-300">Stemme for tilbakemelding</span>
          <span class="ml-2 text-slate-500">
            ${fishAudioConfigured ? '(Fish Audio aktiv)' : '(Nettleser-stemme · legg inn FISH_AUDIO_API_KEY for Fish Audio)'}
          </span>
        </div>
        <button
          type="button"
          data-sensor-action="toggle-auto-speak"
          class="cursor-pointer rounded-lg border px-2.5 py-1 text-xs transition ${
            autoSpeakFeedback
              ? 'border-[#849e52]/50 bg-[#1e2614] text-[#d2e4ab]'
              : 'border-slate-700 bg-slate-950 text-slate-400'
          }"
        >
          ${autoSpeakFeedback ? 'Les opp automatisk: På' : 'Les opp automatisk: Av'}
        </button>
      </div>
    </div>
  `;
}

function renderAiCritiqueSection(
  provider: EvaluatorProvider,
  groqLoading: boolean,
  aiStatus: AiEngineStatus,
  critique: AiSensorCritique | null,
  aiError: string | null,
  addedCardIds: readonly string[],
  speakingTarget: SensorRuntimeState['speakingTarget'],
): string {
  if (provider === 'rubric') {
    return '';
  }

  if (
    groqLoading ||
    (provider === 'local-ai' &&
      (aiStatus.phase === 'running' || (aiStatus.phase === 'loading' && !critique)))
  ) {
    return `
      <div class="rounded-xl border border-[#849e52]/30 bg-slate-950/70 p-4 text-sm text-[#bfd591]">
        ${
          groqLoading
            ? 'Sensor leser svaret ditt og lager tilbakemelding på norsk...'
            : aiStatus.phase === 'loading'
              ? `Laster inn lokal AI (${aiStatus.progress ?? 0}%)...`
              : 'Sensor vurderer grammatikk og innhold...'
        }
      </div>
    `;
  }

  if (aiError) {
    return `
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/35 bg-red-950/20 p-4 text-xs text-red-300" data-testid="ai-error">
        <span>${escapeHtml(aiError)}</span>
        <button
          type="button"
          data-sensor-action="run-ai-critique"
          class="cursor-pointer rounded border border-red-400/40 px-2.5 py-1 text-xs text-red-200 hover:bg-red-500/15"
        >
          Prøv igjen
        </button>
      </div>
    `;
  }

  if (!critique) {
    const canRun =
      provider === 'groq' || (provider === 'local-ai' && aiStatus.phase === 'ready');
    if (!canRun) {
      return '';
    }
    return `
      <div class="flex items-center justify-between gap-3 rounded-xl border border-[#849e52]/35 bg-slate-950/70 p-4">
        <span class="text-xs text-slate-300">
          Vil du ha grundig tilbakemelding på norsk?
        </span>
        <button
          type="button"
          data-sensor-action="run-ai-critique"
          data-testid="run-ai-critique-btn"
          class="cursor-pointer rounded-lg border border-[#849e52]/50 bg-[#1e2614]/80 px-3 py-1.5 text-xs font-medium text-[#d2e4ab] hover:border-[#a3bd6f]"
        >
          Få sensortips
        </button>
      </div>
    `;
  }

  const correctionsHtml =
    critique.corrections.length > 0
      ? critique.corrections
          .map((item, idx) => {
            const cardId = `nb-ai-corr-${idx}-${item.corrected.toLowerCase().replaceAll(/[^a-zæøå0-9]+/g, '-').slice(0, 24)}`;
            const isAdded = addedCardIds.includes(cardId);
            return `
              <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/65 px-3.5 py-2.5">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2 text-sm">
                    <span class="text-red-400 line-through" lang="nb">${escapeHtml(item.original)}</span>
                    <span class="text-slate-500">-&gt;</span>
                    <span class="font-semibold text-[#bfd591]" lang="nb">${escapeHtml(item.corrected)}</span>
                  </div>
                  <div class="mt-0.5 text-xs text-slate-400">${escapeHtml(item.note)}</div>
                </div>
                <button
                  type="button"
                  data-sensor-action="add-ai-card"
                  data-ai-card-index="${idx}"
                  ${isAdded ? 'disabled' : ''}
                  class="cursor-pointer rounded-lg border px-2.5 py-1 text-xs transition disabled:cursor-default ${
                    isAdded
                      ? 'border-[#849e52]/50 bg-[#1e2614]/80 text-[#bfd591]'
                      : 'border-[#849e52]/45 bg-slate-950/80 text-[#d2e4ab] hover:border-[#a3bd6f]'
                  }"
                >
                  ${isAdded ? 'Lagret ✓' : '+ Øv på dette'}
                </button>
              </div>
            `;
          })
          .join('')
      : '<p class="text-xs text-slate-400">Ingen grammatikkfeil funnet i dette svaret.</p>';

  const scoresStrip =
    typeof critique.grammarScore === 'number' && typeof critique.relevanceScore === 'number'
      ? `
        <div class="flex flex-wrap items-center gap-2 text-xs">
          ${critique.bandEstimate ? `<span class="rounded-full border border-[#849e52]/40 bg-[#1e2614]/70 px-2.5 py-0.5 text-[#d2e4ab]">${escapeHtml(critique.bandEstimate)}</span>` : ''}
          <span class="rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-0.5 text-slate-300">Grammatikk ${critique.grammarScore}%</span>
          <span class="rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-0.5 text-slate-300">Innhold ${critique.relevanceScore}%</span>
        </div>
      `
      : '';

  return `
    <div class="rounded-xl border border-[#849e52]/40 bg-[#1e2614]/30 p-4 animate-panel-reveal" data-testid="ai-critique-panel">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5">
        <span class="text-xs font-semibold text-[#bfd591]">
          Tilbakemelding fra sensor
        </span>
        <div class="flex flex-wrap items-center gap-2">
          ${scoresStrip}
          <button
            type="button"
            data-sensor-action="speak-feedback"
            data-testid="speak-feedback-btn"
            class="cursor-pointer rounded-lg border border-[#849e52]/50 bg-slate-950/80 px-2.5 py-1 text-xs text-[#d2e4ab] hover:border-[#a3bd6f]"
          >
            ${speakingTarget === 'feedback' ? 'Stopp stemme' : 'Hør tilbakemelding'}
          </button>
        </div>
      </div>
      <p class="mt-3 text-sm leading-relaxed text-slate-100" lang="nb">
        ${escapeHtml(critique.examinerComment)}
      </p>
      <div class="mt-3 flex flex-col gap-2">
        ${correctionsHtml}
      </div>
    </div>
  `;
}

function renderEvaluationPanel(
  evaluation: SensorEvaluation,
  transcript: string,
  durationMs: number,
  prompt: SensorPrompt,
  state: SensorRuntimeState,
): string {
  const bandClass = getBandBadgeClass(evaluation.bandEstimate);

  const usedConnectorsHtml =
    evaluation.connectorsUsed.length > 0
      ? evaluation.connectorsUsed
          .map(
            (c) =>
              `<span class="rounded-full border border-[#849e52]/40 bg-[#1e2614]/70 px-2.5 py-0.5 text-xs text-[#bfd591]">${escapeHtml(c)}</span>`,
          )
          .join('')
      : '<span class="text-xs text-slate-500">Ingen bindeord fanget opp ennå</span>';

  const missedConnectorsHtml =
    evaluation.connectorsMissed.length > 0
      ? evaluation.connectorsMissed
          .map(
            (c) =>
              `<span class="rounded-full border border-slate-700/70 bg-slate-900/80 px-2.5 py-0.5 text-xs text-slate-400">${escapeHtml(c)}</span>`,
          )
          .join('')
      : '<span class="text-xs text-[#a3bd6f]">Du brukte alle bindeordene!</span>';

  const strengthsHtml = evaluation.strengths
    .map((item) => `<li class="text-xs leading-relaxed text-slate-200">${escapeHtml(item)}</li>`)
    .join('');

  const improvementsHtml = evaluation.improvements
    .map((item) => `<li class="text-xs leading-relaxed text-slate-300">${escapeHtml(item)}</li>`)
    .join('');

  const suggestedCardsHtml = evaluation.suggestedCards
    .map((card, index) => {
      const isAdded = state.addedCardIds.includes(card.id);
      return `
        <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/65 px-3.5 py-2.5">
          <div>
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-slate-100" lang="nb">${escapeHtml(card.word)}</span>
              <span class="font-mono text-xs text-[#a3bd6f]">${escapeHtml(card.ipa)}</span>
            </div>
            <div class="mt-0.5 text-xs text-slate-400">«${escapeHtml(card.exampleNb)}»</div>
          </div>
          <button
            type="button"
            data-sensor-action="add-card"
            data-card-index="${index}"
            data-testid="add-fsrs-card-${escapeHtml(card.id)}"
            ${isAdded ? 'disabled' : ''}
            class="cursor-pointer rounded-lg border px-3 py-1.5 text-xs transition disabled:cursor-default ${
              isAdded
                ? 'border-[#849e52]/50 bg-[#1e2614]/80 text-[#bfd591]'
                : 'border-[#849e52]/45 bg-slate-950/80 text-[#d2e4ab] hover:border-[#a3bd6f] hover:bg-[#849e52]/20'
            }"
          >
            ${isAdded ? 'Lagret ✓' : '+ Lagre til øving'}
          </button>
        </div>
      `;
    })
    .join('');

  const effectiveFollowUp = state.aiCritique?.followUpNb || prompt.followUpNb;
  const showQuickVoiceButton = !state.aiCritique;

  return `
    <div class="flex flex-col gap-4 animate-panel-reveal" data-testid="sensor-evaluation">
      <!-- Oppsummering -->
      <div class="rounded-xl border border-[#849e52]/35 bg-slate-950/75 p-4">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div>
            <div class="text-xs text-slate-400">
              Vurdering av svaret ditt
            </div>
            <div class="mt-1 flex items-baseline gap-2.5">
              <span class="font-mono text-2xl font-semibold text-slate-50" data-testid="sensor-overall-score">
                ${evaluation.overallScore}/100
              </span>
              <span class="text-xs text-slate-400">
                ${formatStopwatch(durationMs)} · ${evaluation.wordCount} ord
              </span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            ${
              showQuickVoiceButton
                ? `
                  <button
                    type="button"
                    data-sensor-action="speak-feedback"
                    data-testid="speak-feedback-btn"
                    class="cursor-pointer rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-200 hover:border-[#849e52]/60"
                  >
                    ${state.speakingTarget === 'feedback' ? 'Stopp stemme' : 'Hør tilbakemelding'}
                  </button>
                `
                : ''
            }
            <span class="rounded-full border px-3 py-1 text-xs font-medium ${bandClass}" data-testid="sensor-band-estimate">
              ${escapeHtml(evaluation.bandEstimate)}
            </span>
          </div>
        </div>

        <div class="mt-3 grid grid-cols-3 gap-2.5">
          <div class="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-center">
            <div class="font-mono text-base font-semibold text-slate-100">${evaluation.durationSeconds}s</div>
            <div class="text-[11px] text-slate-400">Taletid</div>
          </div>
          <div class="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-center">
            <div class="font-mono text-base font-semibold text-[#a3bd6f]">${evaluation.wpm}</div>
            <div class="text-[11px] text-slate-400">Ord / min</div>
          </div>
          <div class="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-center">
            <div class="font-mono text-base font-semibold text-slate-100">${evaluation.cohesionScore}%</div>
            <div class="text-[11px] text-slate-400">Sammenheng</div>
          </div>
        </div>
      </div>

      ${renderAiCritiqueSection(
        state.evaluatorProvider,
        state.groqLoading,
        state.aiStatus,
        state.aiCritique,
        state.aiErrorMessage,
        state.addedCardIds,
        state.speakingTarget,
      )}

      <!-- Det du sa -->
      <div class="rounded-xl border border-slate-800 bg-slate-950/65 p-4" data-testid="sensor-transcript-box">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-medium text-[#bfd591]">
            Dette sa du
          </span>
          <span class="text-xs text-slate-500">
            Fyllord: ${evaluation.totalFillers}
          </span>
        </div>
        <p class="mt-2 text-sm leading-relaxed text-slate-100" lang="nb">
          ${escapeHtml(transcript)}
        </p>
      </div>

      <!-- Styrker og tips -->
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="rounded-xl border border-[#849e52]/25 bg-[#1e2614]/35 p-4">
          <div class="text-xs font-semibold text-[#bfd591]">
            Dette var bra
          </div>
          <ul class="mt-2 list-disc space-y-1.5 pl-4">
            ${strengthsHtml || '<li class="text-xs text-slate-400">Tydelig norsk tale.</li>'}
          </ul>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-950/65 p-4">
          <div class="text-xs font-semibold text-amber-300">
            Tips til neste gang
          </div>
          <ul class="mt-2 list-disc space-y-1.5 pl-4">
            ${improvementsHtml || '<li class="text-xs text-slate-400">Veldig god struktur! Prøv gjerne B2 neste gang.</li>'}
          </ul>
        </div>
      </div>

      <!-- Bindeord -->
      <div class="rounded-xl border border-slate-800 bg-slate-950/65 p-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <div class="text-xs font-medium text-[#a3bd6f]">
              Bindeord du brukte
            </div>
            <div class="mt-2 flex flex-wrap gap-1.5">${usedConnectorsHtml}</div>
          </div>
          <div>
            <div class="text-xs font-medium text-slate-400">
              Prøv også disse
            </div>
            <div class="mt-2 flex flex-wrap gap-1.5">${missedConnectorsHtml}</div>
          </div>
        </div>
      </div>

      <!-- Lagre til ordlisten -->
      ${
        suggestedCardsHtml
          ? `
            <div class="rounded-xl border border-slate-800 bg-slate-950/65 p-4">
              <div class="text-xs font-medium text-[#bfd591]">
                Nyttige ord å øve på
              </div>
              <div class="mt-2.5 flex flex-col gap-2">
                ${suggestedCardsHtml}
              </div>
            </div>
          `
          : ''
      }

      <!-- Oppfølgingsspørsmål -->
      <div class="rounded-xl border border-slate-800 bg-slate-950/65 p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-medium text-slate-300">
            Oppfølgingsspørsmål fra sensor
          </span>
          <div class="flex items-center gap-2">
            <button
              type="button"
              data-sensor-action="toggle-followup"
              class="cursor-pointer text-xs text-slate-400 hover:text-[#bfd591]"
            >
              ${state.showFollowUp ? 'Skjul' : 'Vis'}
            </button>
            <button
              type="button"
              data-sensor-action="speak-followup"
              class="cursor-pointer rounded-lg border border-slate-700/70 bg-slate-900/80 px-2.5 py-1 text-xs text-slate-200 hover:border-[#849e52]/60"
            >
              ${state.speakingTarget === 'followup' ? 'Stopp stemme' : 'Lytt'}
            </button>
          </div>
        </div>
        ${
          state.showFollowUp
            ? `<p class="mt-2.5 text-sm font-medium text-slate-100" lang="nb">${escapeHtml(effectiveFollowUp)}</p>`
            : `<p class="mt-2 text-xs text-slate-500">Trykk «Vis» eller «Lytt» for å øve på oppfølgingsspørsmålet.</p>`
        }
      </div>
    </div>
  `;
}

function renderHistoryPanel(history: readonly SensorAttempt[]): string {
  if (history.length === 0) {
    return '';
  }

  const rows = history
    .slice(0, 5)
    .map((item) => {
      const dateLabel = new Date(item.createdAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      return `
        <div class="flex items-center justify-between gap-3 rounded-lg border border-slate-800/90 bg-slate-950/60 px-3 py-2 text-xs">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-mono text-[11px] text-[#a3bd6f]">${escapeHtml(item.level)}</span>
              <span class="truncate font-medium text-slate-200">${escapeHtml(item.topic)}</span>
            </div>
            <div class="mt-0.5 truncate text-[11px] text-slate-400" lang="nb">
              «${escapeHtml(item.transcript)}»
            </div>
          </div>
          <div class="shrink-0 text-right font-mono">
            <div class="text-xs font-semibold text-slate-100">${item.evaluation.overallScore}/100</div>
            <div class="text-[10px] text-slate-500">${formatStopwatch(item.durationMs)} · ${dateLabel}</div>
          </div>
        </div>
      `;
    })
    .join('');

  return `
    <section class="rounded-2xl border border-slate-800/80 bg-slate-900/45 p-4 backdrop-blur-md" data-testid="sensor-history">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-slate-400">
          Tidligere svar (${history.length})
        </span>
        <button
          type="button"
          data-sensor-action="clear-history"
          class="cursor-pointer text-xs text-slate-500 hover:text-rose-300"
        >
          Tøm
        </button>
      </div>
      <div class="mt-2.5 flex flex-col gap-2">
        ${rows}
      </div>
    </section>
  `;
}

export function renderSensorWorkspace(
  container: HTMLElement,
  params: SensorRenderParams,
): void {
  const { prompt, promptPosition, state, modelStatus, micUnsupportedReason } = params;
  const isRecording = state.phase === 'recording';
  const isTranscribing = state.phase === 'transcribing';
  const shownMs =
    state.phase === 'evaluated' || state.phase === 'transcribing'
      ? state.lastDurationMs
      : state.elapsedMs;
  const zone = getZoneDescriptor(shownMs, state.phase);
  const pct = Math.min(100, Math.round((shownMs / SENSOR_HARD_CAP_MS) * 100));

  const targetStartPct = Math.round((SENSOR_TARGET_MIN_MS / SENSOR_HARD_CAP_MS) * 1000) / 10;
  const targetEndPct = Math.round((SENSOR_TARGET_MAX_MS / SENSOR_HARD_CAP_MS) * 1000) / 10;
  const targetWidthPct = Math.round((targetEndPct - targetStartPct) * 10) / 10;

  const levelTabs = LEVELS.map((level) => {
    const active = level === state.selectedLevel;
    return `
      <button
        type="button"
        data-sensor-action="level"
        data-level="${level}"
        ${isRecording || isTranscribing ? 'disabled' : ''}
        class="cursor-pointer rounded-md px-3 py-1 font-mono text-xs uppercase transition disabled:cursor-not-allowed disabled:opacity-50 ${
          active
            ? 'border border-[#849e52]/50 bg-[#1e2614] text-[#d2e4ab]'
            : 'border border-transparent text-slate-400 hover:text-slate-200'
        }"
      >
        ${level}
      </button>
    `;
  }).join('');

  const recordButtonHtml = (() => {
    if (micUnsupportedReason) {
      return `
        <button
          id="sensor-record-btn"
          type="button"
          disabled
          class="flex w-full cursor-not-allowed items-center justify-center gap-3 rounded-xl border border-slate-700/60 bg-slate-900/60 px-5 py-3.5 text-sm font-medium text-slate-500"
        >
          <span>Mikrofon utilgjengelig</span>
        </button>
      `;
    }
    if (isRecording) {
      return `
        <button
          id="sensor-record-btn"
          type="button"
          data-sensor-action="toggle-record"
          data-testid="sensor-record-btn"
          class="flex w-full cursor-pointer items-center justify-center gap-3 rounded-xl border border-rose-400/65 bg-rose-500/20 px-5 py-3.5 text-sm font-medium text-rose-100 transition hover:bg-rose-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60"
        >
          <span class="h-2.5 w-2.5 rounded-full bg-rose-400 shadow-[0_0_10px_rgba(251,113,133,0.9)] animate-pulse"></span>
          <span>Stopp og få tilbakemelding</span>
        </button>
      `;
    }
    if (isTranscribing) {
      const loadingLabel =
        modelStatus.phase === 'loading' && modelStatus.progress !== null
          ? `Laster talegjenkjenning (${modelStatus.progress}%)...`
          : 'Gjør om tale til tekst...';
      return `
        <button
          id="sensor-record-btn"
          type="button"
          disabled
          class="flex w-full cursor-wait items-center justify-center gap-3 rounded-xl border border-amber-500/45 bg-amber-500/10 px-5 py-3.5 text-sm font-medium text-amber-200"
        >
          <span class="h-2 w-2 rounded-full bg-amber-300 animate-pulse"></span>
          <span>${escapeHtml(loadingLabel)}</span>
        </button>
      `;
    }
    return `
      <button
        id="sensor-record-btn"
        type="button"
        data-sensor-action="toggle-record"
        data-testid="sensor-record-btn"
        class="flex w-full cursor-pointer items-center justify-center gap-3 rounded-xl border border-[#849e52]/45 bg-[#1e2614]/70 px-5 py-3.5 text-sm font-medium text-[#d2e4ab] transition hover:border-[#a3bd6f] hover:bg-[#849e52]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a3bd6f]/60"
      >
        <span class="h-2 w-2 rounded-full bg-[#a3bd6f]"></span>
        <span>${state.phase === 'evaluated' ? 'Svar på nytt' : 'Start svar (1,5–2 min)'}</span>
      </button>
    `;
  })();

  const resultPanelHtml = (() => {
    if (micUnsupportedReason) {
      return `
        <div class="rounded-xl border border-red-500/35 bg-red-950/20 px-4 py-3 text-center text-xs text-red-300">
          ${escapeHtml(micUnsupportedReason)}
        </div>
      `;
    }
    if (state.phase === 'error' && state.errorMessage) {
      return `
        <div class="rounded-xl border border-red-500/35 bg-red-950/20 px-4 py-3 text-center text-xs text-red-300" data-testid="sensor-error">
          ${escapeHtml(state.errorMessage)}
        </div>
      `;
    }
    if (state.phase === 'transcribing') {
      return `
        <div class="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-4 text-center text-xs text-amber-200">
          Gjør om svaret ditt (${formatStopwatch(state.lastDurationMs)}) til tekst...
        </div>
      `;
    }
    if (state.phase === 'evaluated' && state.evaluation) {
      return renderEvaluationPanel(
        state.evaluation,
        state.transcript,
        state.lastDurationMs,
        prompt,
        state,
      );
    }
    return '';
  })();

  container.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1" data-testid="sensor-level-tabs">
        ${levelTabs}
      </div>

      <div class="flex items-center gap-2">
        <span class="text-xs text-slate-400">
          Oppgave ${promptPosition.current}/${promptPosition.total}
        </span>
        <button
          type="button"
          data-sensor-action="next-prompt"
          ${isRecording || isTranscribing ? 'disabled' : ''}
          class="cursor-pointer rounded-lg border border-slate-700/60 bg-slate-950/70 px-3 py-1.5 text-xs text-slate-300 transition hover:border-[#849e52]/60 hover:text-[#d2e4ab] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Nytt spørsmål
        </button>
        <button
          type="button"
          data-sensor-action="toggle-settings"
          data-testid="toggle-settings-btn"
          class="cursor-pointer rounded-lg border border-slate-700/60 bg-slate-950/70 px-2.5 py-1.5 text-xs text-slate-400 transition hover:border-[#849e52]/60 hover:text-slate-200"
        >
          ${state.showSettings ? 'Skjul valg' : 'Valg'}
        </button>
      </div>
    </div>

    ${
      state.showSettings
        ? renderSettingsPanel(
            state.evaluatorProvider,
            state.groqConfigured,
            state.fishAudioConfigured,
            state.autoSpeakFeedback,
            state.aiStatus,
            isRecording || isTranscribing,
          )
        : ''
    }

    <section class="hud-glass relative rounded-2xl p-6 sm:p-8" aria-live="polite">
      <span class="hud-corner hud-corner-tl"></span>
      <span class="hud-corner hud-corner-tr"></span>
      <span class="hud-corner hud-corner-bl"></span>
      <span class="hud-corner hud-corner-br"></span>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <span class="inline-flex items-center gap-2 rounded-full border border-[#849e52]/30 bg-[#1e2614]/55 px-3 py-1 text-xs text-[#bfd591]">
          <span class="h-1.5 w-1.5 rounded-full bg-[#a3bd6f]"></span>
          ${escapeHtml(prompt.level)} · ${escapeHtml(prompt.topic)}
        </span>

        <button
          type="button"
          data-sensor-action="speak-prompt"
          data-testid="sensor-listen-btn"
          class="cursor-pointer rounded-lg border border-slate-700/70 bg-slate-950/70 px-3 py-1.5 text-xs text-slate-200 transition hover:border-[#849e52]/60 hover:text-[#d2e4ab]"
        >
          ${state.speakingTarget === 'prompt' ? 'Stopp stemme' : 'Lytt til spørsmålet'}
        </button>
      </div>

      <p class="mt-6 text-lg font-medium leading-relaxed text-slate-50 sm:text-xl" lang="nb" data-testid="sensor-prompt-text">
        ${escapeHtml(prompt.promptNb)}
      </p>

      ${
        state.ttsStatusMessage
          ? `<p class="mt-2 text-xs text-amber-300">${escapeHtml(state.ttsStatusMessage)}</p>`
          : ''
      }

      <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          data-sensor-action="toggle-hint"
          class="cursor-pointer text-xs text-slate-400 underline-offset-4 hover:text-[#bfd591] hover:underline"
        >
          ${state.showHint ? 'Skjul tips' : 'Vis tips'}
        </button>
        <span class="text-xs text-slate-500">
          Nyttige bindeord: ${escapeHtml(prompt.targetConnectors.slice(0, 3).join(', '))}
        </span>
      </div>

      ${
        state.showHint
          ? `
            <div class="mt-3 rounded-lg border border-slate-700/45 bg-slate-950/60 px-3.5 py-2.5 text-xs text-slate-300 animate-panel-reveal">
              ${escapeHtml(prompt.promptEnHint)}
            </div>
          `
          : ''
      }

      <!-- Stoppeklokke -->
      <div class="mt-7 rounded-xl border border-slate-800/90 bg-slate-950/65 p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-baseline gap-2.5">
            <span
              id="sensor-stopwatch"
              data-testid="sensor-stopwatch"
              class="font-mono text-3xl font-semibold tabular-nums tracking-tight text-slate-50"
            >
              ${formatStopwatch(shownMs)}
            </span>
            <span class="text-xs text-slate-500">/ 02:00 mål</span>
          </div>

          <span
            id="sensor-zone-badge"
            data-testid="sensor-zone-badge"
            class="rounded-full border px-2.5 py-0.5 text-xs ${zone.badgeClass}"
          >
            ${zone.label}
          </span>
        </div>

        <div class="relative mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-800/90">
          <div
            class="absolute inset-y-0 border-x border-[#a3bd6f]/50 bg-[#849e52]/25"
            style="left: ${targetStartPct}%; width: ${targetWidthPct}%"
            title="Mål: 01:30 til 02:00"
          ></div>
          <div
            id="sensor-stopwatch-fill"
            class="relative h-full rounded-full transition-all duration-150 ${zone.barClass}"
            style="width: ${pct}%"
          ></div>
        </div>

        <div class="relative mt-1.5 h-4 font-mono text-[10px] text-slate-500">
          <span class="absolute left-0">00:00</span>
          <span class="absolute -translate-x-1/2 text-[#a3bd6f]" style="left: ${targetStartPct}%">01:30</span>
          <span class="absolute -translate-x-1/2 text-[#a3bd6f]" style="left: ${targetEndPct}%">02:00</span>
          <span class="absolute right-0">02:15</span>
        </div>
      </div>

      ${resultPanelHtml ? `<div class="mt-5">${resultPanelHtml}</div>` : ''}
    </section>

    <div class="w-full">
      ${recordButtonHtml}
    </div>

    ${renderHistoryPanel(state.history)}
  `;
}

export function bindSensorClickActions(
  container: HTMLElement,
  actions: SensorActions,
  getSuggestedCard: (index: number) => CardContent | null,
  getAiSuggestedCard: (index: number) => CardContent | null,
  getFeedbackText: () => string,
  getFollowUpText: () => string,
): () => void {
  const handleClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const button = target.closest<HTMLButtonElement>('button[data-sensor-action]');
    if (!button || button.disabled) {
      return;
    }

    const action = button.dataset.sensorAction;
    if (action === 'level') {
      const level = button.dataset.level;
      if (level === 'A2' || level === 'B1' || level === 'B2') {
        actions.onSelectLevel(level);
      }
      return;
    }
    if (action === 'select-evaluator') {
      const provider = button.dataset.provider;
      if (provider === 'groq' || provider === 'local-ai' || provider === 'rubric') {
        actions.onSelectEvaluator(provider);
      }
      return;
    }
    if (action === 'next-prompt') {
      actions.onNextPrompt();
      return;
    }
    if (action === 'toggle-hint') {
      actions.onToggleHint();
      return;
    }
    if (action === 'toggle-settings') {
      actions.onToggleSettings();
      return;
    }
    if (action === 'toggle-auto-speak') {
      actions.onToggleAutoSpeak();
      return;
    }
    if (action === 'speak-prompt') {
      actions.onSpeakPrompt();
      return;
    }
    if (action === 'speak-feedback') {
      actions.onSpeakFeedback(getFeedbackText());
      return;
    }
    if (action === 'speak-followup') {
      actions.onSpeakFollowUp(getFollowUpText());
      return;
    }
    if (action === 'toggle-followup') {
      actions.onToggleFollowUp();
      return;
    }
    if (action === 'toggle-record') {
      actions.onToggleRecording();
      return;
    }
    if (action === 'enable-ai') {
      actions.onEnableAiSensor();
      return;
    }
    if (action === 'run-ai-critique') {
      actions.onRunAiCritique();
      return;
    }
    if (action === 'clear-history') {
      actions.onClearHistory();
      return;
    }
    if (action === 'add-card') {
      const index = Number(button.dataset.cardIndex);
      const card = Number.isInteger(index) ? getSuggestedCard(index) : null;
      if (card) {
        actions.onAddCardToDeck(card);
      }
      return;
    }
    if (action === 'add-ai-card') {
      const index = Number(button.dataset.aiCardIndex);
      const card = Number.isInteger(index) ? getAiSuggestedCard(index) : null;
      if (card) {
        actions.onAddCardToDeck(card);
      }
    }
  };

  container.addEventListener('click', handleClick);
  return () => {
    container.removeEventListener('click', handleClick);
  };
}
