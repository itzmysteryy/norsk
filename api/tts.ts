import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleTtsEndpoint } from '../server/apiHandlers.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleTtsEndpoint(req, res, {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    APP_PASSWORD: process.env.APP_PASSWORD,
    AUTH_SECRET: process.env.AUTH_SECRET,
    FISH_AUDIO_API_KEY: process.env.FISH_AUDIO_API_KEY,
    FISH_AUDIO_VOICE_ID: process.env.FISH_AUDIO_VOICE_ID,
    FISH_AUDIO_MODEL: process.env.FISH_AUDIO_MODEL,
  });
}
