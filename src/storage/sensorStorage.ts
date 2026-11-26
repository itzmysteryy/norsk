import { createStore, get, set } from 'idb-keyval';
import type { SensorAttempt } from '../types/sensor.ts';

const SENSOR_STORE = createStore('honest-norsk-sensor-db', 'sensor-store');
const ATTEMPTS_KEY = 'honest-norsk:sensor-attempts:v1';
const MAX_STORED_ATTEMPTS = 20;

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
