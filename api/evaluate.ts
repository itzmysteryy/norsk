import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleEvaluateEndpoint } from '../server/apiHandlers.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleEvaluateEndpoint(req, res, {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    APP_PASSWORD: process.env.APP_PASSWORD,
    AUTH_SECRET: process.env.AUTH_SECRET,
  });
}
