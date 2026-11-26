import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const COOKIE_NAME = 'hn_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const FISH_AUDIO_TTS_URL = 'https://api.fish.audio/v1/tts';

export interface ServerEnv {
  readonly GROQ_API_KEY?: string;
  readonly APP_PASSWORD?: string;
  readonly AUTH_SECRET?: string;
  readonly FISH_AUDIO_API_KEY?: string;
  readonly FISH_AUDIO_VOICE_ID?: string;
  readonly FISH_AUDIO_MODEL?: string;
}

interface SessionPayload {
  readonly iat: number;
  readonly exp: number;
}

export interface GroqEvaluateRequestBody {
  readonly level?: string;
  readonly promptNb?: string;
  readonly transcript?: string;
  readonly durationSeconds?: number;
}

export interface TtsRequestBody {
  readonly text?: string;
}

function getSigningSecret(env: ServerEnv): Buffer {
  const raw =
    env.AUTH_SECRET?.trim() ||
    `${env.APP_PASSWORD ?? ''}::${env.GROQ_API_KEY ?? ''}::honest-norsk`;
  return crypto.createHash('sha256').update(raw).digest();
}

function safeEqualText(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function signSession(payload: SessionPayload, secret: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifySessionToken(token: string, secret: Buffer): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return false;
  }
  const [encoded, providedSig] = parts;
  if (!encoded || !providedSig) {
    return false;
  }

  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const sigBufA = Buffer.from(providedSig, 'utf8');
  const sigBufB = Buffer.from(expectedSig, 'utf8');
  if (sigBufA.length !== sigBufB.length || !crypto.timingSafeEqual(sigBufA, sigBufB)) {
    return false;
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<SessionPayload>;
    return typeof decoded.exp === 'number' && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) {
    return result;
  }
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) {
      result[key] = decodeURIComponent(val);
    }
  }
  return result;
}

function isRequestHttps(req: IncomingMessage): boolean {
  const xfProto = req.headers['x-forwarded-proto'];
  if (typeof xfProto === 'string' && xfProto.toLowerCase().includes('https')) {
    return true;
  }
  const socket = req.socket as { encrypted?: boolean } | undefined;
  return Boolean(socket?.encrypted);
}

export function isRequestAuthenticated(req: IncomingMessage, env: ServerEnv): boolean {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) {
    return false;
  }
  return verifySessionToken(token, getSigningSecret(env));
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const preParsed = (req as IncomingMessage & { body?: unknown }).body;
  if (preParsed && typeof preParsed === 'object') {
    return preParsed as T;
  }
  if (typeof preParsed === 'string' && preParsed.length > 0) {
    return JSON.parse(preParsed) as T;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

export function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders?: Record<string, string | string[]>,
): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, v);
    }
  }
  res.end(JSON.stringify(body));
}

export async function handleAuthEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  env: ServerEnv,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'GET') {
    const authenticated = isRequestAuthenticated(req, env);
    sendJson(res, 200, {
      authenticated,
      groqConfigured: Boolean(env.GROQ_API_KEY?.trim()),
      fishAudioConfigured: Boolean(env.FISH_AUDIO_API_KEY?.trim()),
      model: GROQ_MODEL,
    });
    return;
  }

  if (method === 'DELETE') {
    const secureFlag = isRequestHttps(req) ? '; Secure' : '';
    sendJson(
      res,
      200,
      { authenticated: false },
      {
        'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`,
      },
    );
    return;
  }

  if (method === 'POST') {
    const configuredPassword = env.APP_PASSWORD;
    if (!configuredPassword) {
      sendJson(res, 500, {
        error: 'Passord er ikke satt opp på serveren (APP_PASSWORD).',
      });
      return;
    }

    let body: { password?: unknown };
    try {
      body = await readJsonBody<{ password?: unknown }>(req);
    } catch {
      sendJson(res, 400, { error: 'Ugyldig forespørsel.' });
      return;
    }

    const submitted = typeof body.password === 'string' ? body.password : '';
    if (!submitted || !safeEqualText(submitted, configuredPassword)) {
      sendJson(res, 401, { error: 'Feil passord. Prøv igjen.' });
      return;
    }

    const now = Date.now();
    const token = signSession(
      { iat: now, exp: now + SESSION_TTL_MS },
      getSigningSecret(env),
    );
    const secureFlag = isRequestHttps(req) ? '; Secure' : '';
    const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);

    sendJson(
      res,
      200,
      {
        authenticated: true,
        groqConfigured: Boolean(env.GROQ_API_KEY?.trim()),
        fishAudioConfigured: Boolean(env.FISH_AUDIO_API_KEY?.trim()),
        model: GROQ_MODEL,
      },
      {
        'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureFlag}`,
      },
    );
    return;
  }

  sendJson(res, 405, { error: 'Metode ikke tillatt.' });
}

function normalizeGroqCritique(rawContent: string): {
  readonly examinerComment: string;
  readonly bandEstimate: string;
  readonly grammarScore: number;
  readonly relevanceScore: number;
  readonly corrections: ReadonlyArray<{
    readonly original: string;
    readonly corrected: string;
    readonly note: string;
  }>;
  readonly followUpNb: string;
} {
  const trimmed = rawContent.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const jsonSlice = start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed;

  const parsed = JSON.parse(jsonSlice) as {
    examinerComment?: unknown;
    bandEstimate?: unknown;
    grammarScore?: unknown;
    relevanceScore?: unknown;
    corrections?: unknown;
    followUpNb?: unknown;
  };

  const clampPct = (val: unknown, fallback: number): number => {
    if (typeof val !== 'number' || Number.isNaN(val)) {
      return fallback;
    }
    return Math.max(0, Math.min(100, Math.round(val)));
  };

  const rawCorrections = Array.isArray(parsed.corrections) ? parsed.corrections : [];
  const corrections = rawCorrections
    .filter(
      (item): item is { original: string; corrected: string; note?: unknown } =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { original?: unknown }).original === 'string' &&
        typeof (item as { corrected?: unknown }).corrected === 'string',
    )
    .slice(0, 5)
    .map((item) => ({
      original: item.original.trim(),
      corrected: item.corrected.trim(),
      note:
        typeof item.note === 'string' && item.note.trim()
          ? item.note.trim()
          : 'Naturligere norsk setningsbygning eller grammatikk.',
    }))
    .filter((item) => item.original.length > 0 && item.corrected.length > 0);

  return {
    examinerComment:
      typeof parsed.examinerComment === 'string' && parsed.examinerComment.trim()
        ? parsed.examinerComment.trim()
        : 'Svaret ditt er vurdert av norsk sensor.',
    bandEstimate:
      typeof parsed.bandEstimate === 'string' && parsed.bandEstimate.trim()
        ? parsed.bandEstimate.trim()
        : 'B1',
    grammarScore: clampPct(parsed.grammarScore, 70),
    relevanceScore: clampPct(parsed.relevanceScore, 75),
    corrections,
    followUpNb:
      typeof parsed.followUpNb === 'string' && parsed.followUpNb.trim()
        ? parsed.followUpNb.trim()
        : '',
  };
}

export async function handleEvaluateEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  env: ServerEnv,
): Promise<void> {
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    sendJson(res, 405, { error: 'Metode ikke tillatt.' });
    return;
  }

  if (!isRequestAuthenticated(req, env)) {
    sendJson(res, 401, { error: 'Ikke innlogget. Lås opp med passord først.' });
    return;
  }

  const apiKey = env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    sendJson(res, 503, {
      error: 'GROQ_API_KEY mangler i .env / Vercel.',
    });
    return;
  }

  let body: GroqEvaluateRequestBody;
  try {
    body = await readJsonBody<GroqEvaluateRequestBody>(req);
  } catch {
    sendJson(res, 400, { error: 'Ugyldig JSON.' });
    return;
  }

  const level = typeof body.level === 'string' ? body.level : 'B1';
  const promptNb = typeof body.promptNb === 'string' ? body.promptNb.trim() : '';
  const transcript = typeof body.transcript === 'string' ? body.transcript.trim() : '';
  const durationSeconds =
    typeof body.durationSeconds === 'number' && Number.isFinite(body.durationSeconds)
      ? Math.max(1, Math.round(body.durationSeconds))
      : 1;

  if (!promptNb || !transcript) {
    sendJson(res, 400, { error: 'Både oppgave og tekst kreves.' });
    return;
  }

  const systemPrompt = [
    'Du er en vennlig, tydelig og rettferdig norsk sensor på Norskprøven muntlig.',
    'Skriv ALL tilbakemelding på enkelt, klart og naturlig norsk bokmål (aldri på engelsk), tilpasset en innlærer.',
    'Vurder svaret opp mot oppgaven og målnivået (A2, B1 eller B2): innhold, sammenheng, lengde (mål 1,5–2 min), ordstilling (V2-regelen), kjønn (en/ei/et), bestemt form, preposisjoner og verbtid.',
    'Svar KUN med gyldig JSON i dette formatet:',
    '{"examinerComment":"2–3 korte, oppmuntrende og konkrete setninger på enkelt norsk bokmål om hva som var bra og hva som kan bli bedre","bandEstimate":"f.eks. A2 på vei, B1 stødig, eller B2 sterk","grammarScore":0-100,"relevanceScore":0-100,"corrections":[{"original":"uttrykk fra svaret","corrected":"riktig/naturlig norsk bokmål","note":"kort og enkel forklaring på norsk"}],"followUpNb":"Ett naturlig oppfølgingsspørsmål på norsk bokmål som passer til det kandidaten sa."}',
  ].join(' ');

  const userPrompt = [
    `Målnivå: ${level}`,
    `Taletid: ${durationSeconds} sekunder (mål 90–120 sekunder)`,
    `Oppgave: ${promptNb}`,
    `Kandidatens svar: """${transcript}"""`,
  ].join('\n');

  try {
    const groqRes = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_completion_tokens: 1400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!groqRes.ok) {
      const errorText = await groqRes.text();
      sendJson(res, groqRes.status, {
        error: `Groq-feil (${groqRes.status}): ${errorText.slice(0, 300)}`,
      });
      return;
    }

    const groqData = (await groqRes.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = groqData.choices?.[0]?.message?.content ?? '';
    if (!content) {
      sendJson(res, 502, { error: 'Tomt svar fra Groq.' });
      return;
    }

    const critique = normalizeGroqCritique(content);
    sendJson(res, 200, {
      ...critique,
      model: GROQ_MODEL,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Kunne ikke kontakte Groq.';
    sendJson(res, 502, { error: message });
  }
}

export async function handleTtsEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  env: ServerEnv,
): Promise<void> {
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    sendJson(res, 405, { error: 'Metode ikke tillatt.' });
    return;
  }

  if (!isRequestAuthenticated(req, env)) {
    sendJson(res, 401, { error: 'Ikke innlogget.' });
    return;
  }

  const fishKey = env.FISH_AUDIO_API_KEY?.trim();
  if (!fishKey) {
    sendJson(res, 503, {
      error: 'FISH_AUDIO_API_KEY mangler i .env / Vercel.',
    });
    return;
  }

  let body: TtsRequestBody;
  try {
    body = await readJsonBody<TtsRequestBody>(req);
  } catch {
    sendJson(res, 400, { error: 'Ugyldig JSON.' });
    return;
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    sendJson(res, 400, { error: 'Tekst mangler.' });
    return;
  }

  const payload: Record<string, unknown> = {
    text: text.slice(0, 1200),
    format: 'mp3',
    normalize: true,
  };

  const voiceId = env.FISH_AUDIO_VOICE_ID?.trim();
  if (voiceId) {
    payload.reference_id = voiceId;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${fishKey}`,
    'Content-Type': 'application/json',
  };
  const model = env.FISH_AUDIO_MODEL?.trim();
  if (model) {
    headers.model = model;
  }

  try {
    const fishRes = await fetch(FISH_AUDIO_TTS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!fishRes.ok) {
      const errorText = await fishRes.text();
      sendJson(res, fishRes.status, {
        error: `Fish Audio-feil (${fishRes.status}): ${errorText.slice(0, 240)}`,
      });
      return;
    }

    const audioBuffer = Buffer.from(await fishRes.arrayBuffer());
    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.end(audioBuffer);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Kunne ikke kontakte Fish Audio.';
    sendJson(res, 502, { error: message });
  }
}
