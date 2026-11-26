import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePromptsEndpoint } from '../server/apiHandlers.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handlePromptsEndpoint(req, res, {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    APP_PASSWORD: process.env.APP_PASSWORD,
    AUTH_SECRET: process.env.AUTH_SECRET,
  });
}
