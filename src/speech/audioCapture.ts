const WHISPER_SAMPLE_RATE = 16_000;

export interface AudioRecorderSession {
  readonly stop: () => Promise<Float32Array>;
  readonly cancel: () => void;
}

export function isMicrophoneSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof AudioContext !== 'undefined'
  );
}

export function formatMicrophoneError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'Mikrofonen er blokkert. Gi tilgang til mikrofon i nettleseren.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'Fant ingen mikrofon på denne enheten.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Mikrofonen brukes av en annen app.';
      default:
        return err.message || `Mikrofonfeil (${err.name}).`;
    }
  }
  return err instanceof Error ? err.message : 'Kunne ikke bruke mikrofonen.';
}

function concatChunks(chunks: readonly Float32Array[]): Float32Array {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }

  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function resampleTo16k(samples: Float32Array, sourceRate: number): Float32Array {
  if (samples.length === 0 || sourceRate === WHISPER_SAMPLE_RATE) {
    return samples;
  }

  const ratio = sourceRate / WHISPER_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const srcPos = i * ratio;
    const low = Math.floor(srcPos);
    const high = Math.min(low + 1, samples.length - 1);
    const frac = srcPos - low;
    const s0 = samples[low] ?? 0;
    const s1 = samples[high] ?? s0;
    output[i] = s0 + (s1 - s0) * frac;
  }

  return output;
}

export function hasAudioSignal(samples: Float32Array): boolean {
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i] ?? 0) > 1e-5) {
      return true;
    }
  }
  return false;
}

const WORKLET_PROCESSOR_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
`;

export async function startMicrophoneCapture(): Promise<AudioRecorderSession> {
  if (!isMicrophoneSupported()) {
    throw new Error(
      'Microphone capture (getUserMedia / AudioContext) is unavailable in this browser.',
    );
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  const source = audioCtx.createMediaStreamSource(stream);
  const silentSink = audioCtx.createGain();
  silentSink.gain.value = 0;
  silentSink.connect(audioCtx.destination);

  const chunks: Float32Array[] = [];
  let disconnectCapture: () => void = () => {};

  const stopTracks = (): void => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  };

  try {
    if (typeof AudioWorkletNode !== 'undefined' && audioCtx.audioWorklet) {
      const workletBlob = new Blob([WORKLET_PROCESSOR_SOURCE], {
        type: 'application/javascript',
      });
      const workletUrl = URL.createObjectURL(workletBlob);
      try {
        await audioCtx.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }

      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture-processor');
      workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (event.data instanceof Float32Array) {
          chunks.push(event.data);
        }
      };

      source.connect(workletNode);
      workletNode.connect(silentSink);

      disconnectCapture = () => {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
      };
    } else {
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        const channel = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(channel));
      };

      source.connect(processor);
      processor.connect(silentSink);

      disconnectCapture = () => {
        processor.onaudioprocess = null;
        processor.disconnect();
      };
    }
  } catch {
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      const channel = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(channel));
    };

    source.connect(processor);
    processor.connect(silentSink);

    disconnectCapture = () => {
      processor.onaudioprocess = null;
      processor.disconnect();
    };
  }

  let closed = false;

  const cleanup = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    disconnectCapture();
    source.disconnect();
    silentSink.disconnect();
    stopTracks();
    await audioCtx.close();
  };

  return {
    stop: async (): Promise<Float32Array> => {
      const sampleRate = audioCtx.sampleRate;
      await cleanup();
      const rawPcm = concatChunks(chunks);
      chunks.length = 0;
      return resampleTo16k(rawPcm, sampleRate);
    },

    cancel: (): void => {
      chunks.length = 0;
      void cleanup();
    },
  };
}
