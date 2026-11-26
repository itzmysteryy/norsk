import type { Grade } from 'ts-fsrs';
import type { AppMode } from '../types/sensor.ts';

export interface KeyboardHandlers {
  readonly getMode: () => AppMode;
  readonly canFlip: () => boolean;
  readonly canRate: () => boolean;
  readonly canSpeak: () => boolean;
  readonly onFlip: () => void;
  readonly onRate: (grade: Grade) => void;
  readonly onReset: () => void;
  readonly onSpeakStart: () => void;
  readonly onSpeakStop: () => void;
  readonly onSensorToggleRecord: () => void;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function parseGradeKey(key: string): Grade | null {
  switch (key) {
    case '1':
      return 1;
    case '2':
      return 2;
    case '3':
      return 3;
    case '4':
      return 4;
    default:
      return null;
  }
}

export function bindKeyboardControls(handlers: KeyboardHandlers): () => void {
  let isVoiceKeyHeld = false;

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (isEditableElement(event.target)) {
      return;
    }

    if (handlers.getMode() === 'sensor') {
      if (event.code === 'Space' && !event.repeat) {
        if (event.target instanceof HTMLButtonElement) {
          return;
        }
        event.preventDefault();
        handlers.onSensorToggleRecord();
      }
      return;
    }

    if ((event.key === 'v' || event.key === 'V') && !event.repeat) {
      if (handlers.canSpeak()) {
        event.preventDefault();
        isVoiceKeyHeld = true;
        handlers.onSpeakStart();
      }
      return;
    }

    if (event.code === 'Space') {
      if (event.target instanceof HTMLButtonElement && event.target.id === 'hold-to-speak-btn') {
        return;
      }
      event.preventDefault();
      if (handlers.canFlip()) {
        handlers.onFlip();
      }
      return;
    }

    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      handlers.onReset();
      return;
    }

    const grade = parseGradeKey(event.key);
    if (grade !== null && handlers.canRate()) {
      event.preventDefault();
      handlers.onRate(grade);
    }
  };

  const handleKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'v' || event.key === 'V') {
      if (isVoiceKeyHeld) {
        event.preventDefault();
        isVoiceKeyHeld = false;
        handlers.onSpeakStop();
      }
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);

  return () => {
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
  };
}
