export interface AuthSessionStatus {
  readonly authenticated: boolean;
  readonly groqConfigured: boolean;
  readonly fishAudioConfigured: boolean;
  readonly model: string;
}

export async function checkAuthSession(): Promise<AuthSessionStatus> {
  const response = await fetch('/api/auth', {
    method: 'GET',
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error(`Kunne ikke sjekke innlogging (${response.status}).`);
  }

  return (await response.json()) as AuthSessionStatus;
}

export async function unlockWithPassword(password: string): Promise<AuthSessionStatus> {
  const response = await fetch('/api/auth', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    authenticated?: boolean;
    groqConfigured?: boolean;
    fishAudioConfigured?: boolean;
    model?: string;
  };

  if (!response.ok) {
    throw new Error(payload.error || `Innlogging feilet (${response.status}).`);
  }

  return {
    authenticated: Boolean(payload.authenticated),
    groqConfigured: Boolean(payload.groqConfigured),
    fishAudioConfigured: Boolean(payload.fishAudioConfigured),
    model: payload.model || 'openai/gpt-oss-120b',
  };
}

export async function lockSession(): Promise<void> {
  await fetch('/api/auth', {
    method: 'DELETE',
    credentials: 'same-origin',
  });
}
