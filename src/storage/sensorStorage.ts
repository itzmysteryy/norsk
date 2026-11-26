import { createStore, get, set } from 'idb-keyval';
import type { SensorAttempt, SensorPrompt } from '../types/sensor.ts';

const SENSOR_STORE = createStore('honest-norsk-sensor-db', 'sensor-store');
const ATTEMPTS_KEY = 'honest-norsk:sensor-attempts:v1';
const CUSTOM_PROMPTS_KEY = 'honest-norsk:custom-prompts:v1';
const AUTO_TTS_STORAGE_KEY = 'honest-norsk:auto-tts:v1';
const MAX_STORED_ATTEMPTS = 20;
const MAX_CUSTOM_PROMPTS = 40;

export async function loadSensorHistory(): Promise<SensorAttempt[]> {
  const existing = await get<SensorAttempt[]>(ATTEMPTS_KEY, SENSOR_STORE);
  return existing ? [...existing] : [];
}

export async function saveSensorAttempt(attempt: SensorAttempt): Promise<SensorAttempt[]> {
  const existing = await loadSensorHistory();
  const updated = [attempt, ...existing].slice(0, MAX_STORED_ATTEMPTS);
  await set(ATTEMPTS_KEY, updated, SENSOR_STORE);
  return updated;
}

export async function clearSensorHistory(): Promise<void> {
  await set(ATTEMPTS_KEY, [], SENSOR_STORE);
}

export async function loadCustomSensorPrompts(): Promise<SensorPrompt[]> {
  const existing = await get<SensorPrompt[]>(CUSTOM_PROMPTS_KEY, SENSOR_STORE);
  return existing ? [...existing] : [];
}

export async function appendCustomSensorPrompts(
  newPrompts: readonly SensorPrompt[],
): Promise<SensorPrompt[]> {
  const existing = await loadCustomSensorPrompts();
  const updated = [...existing, ...newPrompts].slice(-MAX_CUSTOM_PROMPTS);
  await set(CUSTOM_PROMPTS_KEY, updated, SENSOR_STORE);
  return updated;
}

export async function clearCustomSensorPrompts(): Promise<void> {
  await set(CUSTOM_PROMPTS_KEY, [], SENSOR_STORE);
}

export function loadAutoTtsPreference(): boolean {
  try {
    const saved = window.localStorage.getItem(AUTO_TTS_STORAGE_KEY);
    if (saved === 'false') {
      return false;
    }
    if (saved === 'true') {
      return true;
    }
  } catch {
    // Ignore storage restriction and use default true.
  }
  return true;
}

export function saveAutoTtsPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(AUTO_TTS_STORAGE_KEY, String(enabled));
  } catch {
    // Ignore storage restriction.
  }
}
