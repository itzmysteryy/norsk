import fs from 'node:fs';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import {
  handleAuthEndpoint,
  handleEvaluateEndpoint,
  handlePromptsEndpoint,
  handleTtsEndpoint,
} from './server/apiHandlers.ts';

function localApiDevPlugin(mode: string): Plugin {
  return {
    name: 'honest-norsk-local-api',
    configureServer(server) {
      const env = loadEnv(mode, process.cwd(), '');

      server.middlewares.use('/api/auth', (req, res, next) => {
        if (!req.url || req.url === '/' || req.url.startsWith('/?')) {
          void handleAuthEndpoint(req, res, env);
          return;
        }
        next();
      });

      server.middlewares.use('/api/evaluate', (req, res, next) => {
        if (!req.url || req.url === '/' || req.url.startsWith('/?')) {
          void handleEvaluateEndpoint(req, res, env);
          return;
        }
        next();
      });

      server.middlewares.use('/api/prompts', (req, res, next) => {
        if (!req.url || req.url === '/' || req.url.startsWith('/?')) {
          void handlePromptsEndpoint(req, res, env);
          return;
        }
        next();
      });

      server.middlewares.use('/api/tts', (req, res, next) => {
        if (!req.url || req.url === '/' || req.url.startsWith('/?')) {
          void handleTtsEndpoint(req, res, env);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const useHttpsLan = process.env.VITE_HTTPS_LAN === '1';
  const certPath = process.env.VITE_LAN_CERT;
  const keyPath = process.env.VITE_LAN_KEY;

  return {
    plugins: [tailwindcss(), localApiDevPlugin(mode)],
    worker: {
      format: 'es',
    },
    ...(useHttpsLan && certPath && keyPath
      ? {
          server: {
            host: '0.0.0.0',
            port: 5174,
            strictPort: true,
            https: {
              cert: fs.readFileSync(certPath),
              key: fs.readFileSync(keyPath),
            },
          },
        }
      : {}),
  };
});
