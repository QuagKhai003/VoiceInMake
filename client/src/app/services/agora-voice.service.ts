import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import AgoraRTC, { IMicrophoneAudioTrack } from 'agora-rtc-sdk-ng';

export type ConversationState =
  | 'inactive'    // mic off
  | 'waiting'     // mic on, listening for speech start
  | 'speaking'    // confirmed speech in progress
  | 'sending'     // flushing chunk to backend
  | 'processing'; // waiting for API response

/**
 * VAD state machine:
 *   inactive → [startConversation()] → waiting
 *   waiting  → [speech > threshold for SPEECH_CONFIRM_MS] → speaking
 *   speaking → [silence > SILENCE_AFTER_SPEECH_MS] → sending → waiting
 *   any      → [stopConversation()] → inactive
 *
 * Processing lock: when isLocked=true (API call in flight), VAD keeps running
 * but will NOT flush new chunks. Audio accumulates and the next flush
 * happens after the lock is released.
 */
@Injectable({ providedIn: 'root' })
export class AgoraVoiceService {
  // ── VAD tuning ──────────────────────────────────────────────────
  /** RMS amplitude above this = "speech". Raise if background noise triggers it. */
  private readonly SPEECH_THRESHOLD = 0.04;
  /** Must stay above threshold for this long before we consider it real speech (ms). */
  private readonly SPEECH_CONFIRM_MS = 400;
  /** Silence after confirmed speech this long → flush chunk (ms). 1.5s for natural turn-taking. */
  private readonly SILENCE_AFTER_SPEECH_MS = 1500;
  /** A chunk must contain at least this much total confirmed-speech time to be sent (ms). */
  private readonly MIN_SPEECH_IN_CHUNK_MS = 1200;
  /** Minimum blob size in bytes — rejects Whisper-hallucination-prone tiny clips. */
  private readonly MIN_BLOB_BYTES = 3000;
  /**
   * If the conversation is active but no speech is detected for this long (ms),
   * emit inactivity$ so the app can prompt the user.
   */
  private readonly INACTIVITY_PROMPT_MS = 10000;

  // ── Internal state ───────────────────────────────────────────────
  private localAudioTrack: IMicrophoneAudioTrack | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private audioContext: AudioContext | null = null;
  private vadFrameId: number | null = null;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  private isConversationActive = false;
  /** External lock: set true while API call is in flight so VAD won't flush. */
  private processingLocked = false;

  // VAD sub-state
  private speechConfirmStart: number | null = null; // when above-threshold streak began
  private silenceAfterSpeechStart: number | null = null;
  private totalSpeechMsInChunk = 0;
  private lastFrameTime = 0;
  private confirmedSpeechActive = false; // true after SPEECH_CONFIRM_MS passed

  // ── Public streams ────────────────────────────────────────────────
  public audioBlob$ = new Subject<Blob>();
  public conversationState$ = new Subject<ConversationState>();
  public error$ = new Subject<string>();
  /** Fires when mic has been open but silent for INACTIVITY_PROMPT_MS. */
  public inactivity$ = new Subject<void>();
  /** Fires when user starts speaking while AI is talking — caller should stop TTS. */
  public bargeIn$ = new Subject<void>();

  // ── Public API ────────────────────────────────────────────────────

  async startConversation(): Promise<void> {
    if (this.isConversationActive) return;
    try {
      this.localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
        encoderConfig: { sampleRate: 16000, stereo: false, bitrate: 128 },
        AEC: true,
        ANS: true,
        AGC: true
      });

      const stream = new MediaStream([this.localAudioTrack.getMediaStreamTrack()]);
      this.isConversationActive = true;
      this.resetChunkState();
      this.beginRecordingChunk(stream);
      this.setupVAD(stream);
      this.conversationState$.next('waiting');
      this.startInactivityTimer();
    } catch (err: any) {
      const insecure = typeof window !== 'undefined' && !window.isSecureContext;
      this.error$.next(
        insecure
          ? 'Microphone blocked: open http://localhost:4200 (not the WSL IP).'
          : `Microphone error: ${err?.message ?? 'permission denied'}`
      );
    }
  }

  stopConversation(): void {
    if (!this.isConversationActive) return;
    this.isConversationActive = false;
    this.clearInactivityTimer();
    this.stopVAD();
    this.discardCurrentChunk();
    this.cleanup();
    this.conversationState$.next('inactive');
  }

  /** Called by component when an API response is received (or fails). */
  releaseProcessingLock(): void {
    this.processingLocked = false;
    if (this.isConversationActive) {
      this.conversationState$.next('waiting');
    }
  }

  /**
   * Pause VAD while TTS is playing — prevents the assistant's own voice
   * from being picked up as user speech.
   */
  pauseForSpeaking(): void {
    this.processingLocked = true;
  }

  /** Resume after TTS finishes. */
  resumeAfterSpeaking(): void {
    this.restartAfterProcessing();
    this.startInactivityTimer(); // restart timer after assistant finishes speaking
  }

  // ── VAD ──────────────────────────────────────────────────────────

  private setupVAD(stream: MediaStream): void {
    this.audioContext = new AudioContext();
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 256;
    this.audioContext.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);

    const tick = (timestamp: number) => {
      if (!this.isConversationActive) return;

      const dt = this.lastFrameTime ? timestamp - this.lastFrameTime : 16;
      this.lastFrameTime = timestamp;

      analyser.getFloatTimeDomainData(buffer);
      const rms = Math.sqrt(buffer.reduce((s, v) => s + v * v, 0) / buffer.length);
      const isSpeech = rms > this.SPEECH_THRESHOLD;

      if (isSpeech) {
        this.silenceAfterSpeechStart = null;
        this.clearInactivityTimer(); // reset idle timer while user speaks

        if (this.speechConfirmStart === null) {
          this.speechConfirmStart = Date.now();
        } else if (!this.confirmedSpeechActive && Date.now() - this.speechConfirmStart >= this.SPEECH_CONFIRM_MS) {
          // Speech confirmed — begin counting speech time
          this.confirmedSpeechActive = true;
          this.conversationState$.next('speaking');

          // Barge-in: user spoke while AI was talking — unlock so this turn can flush
          if (this.processingLocked) {
            this.processingLocked = false;
            this.bargeIn$.next();
          }
        }

        if (this.confirmedSpeechActive) {
          this.totalSpeechMsInChunk += dt;
        }
      } else {
        this.speechConfirmStart = null;

        if (this.confirmedSpeechActive) {
          // We had real speech and now silence started
          if (this.silenceAfterSpeechStart === null) {
            this.silenceAfterSpeechStart = Date.now();
          } else if (Date.now() - this.silenceAfterSpeechStart >= this.SILENCE_AFTER_SPEECH_MS) {
            // Enough silence after speech — try to flush
            if (!this.processingLocked) {
              this.flushChunk();
            }
            // Reset for next chunk regardless
            this.silenceAfterSpeechStart = null;
            this.confirmedSpeechActive = false;
            this.speechConfirmStart = null;
          }
        }
      }

      this.vadFrameId = requestAnimationFrame(tick);
    };

    this.vadFrameId = requestAnimationFrame(tick);
  }

  private flushChunk(): void {
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') return;
    if (this.totalSpeechMsInChunk < this.MIN_SPEECH_IN_CHUNK_MS) {
      // Not enough real speech — skip and reset
      this.resetChunkState();
      if (this.localAudioTrack) {
        this.beginRecordingChunk(new MediaStream([this.localAudioTrack.getMediaStreamTrack()]));
      }
      return;
    }

    this.processingLocked = true;
    this.conversationState$.next('sending');

    const recorder = this.mediaRecorder;
    const chunks = [...this.audioChunks];
    const mimeType = recorder.mimeType || 'audio/webm';

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size >= this.MIN_BLOB_BYTES) {
        this.conversationState$.next('processing');
        this.audioBlob$.next(blob);
      } else {
        // Too small — likely noise; release lock and restart
        this.processingLocked = false;
        if (this.isConversationActive && this.localAudioTrack) {
          this.resetChunkState();
          this.beginRecordingChunk(new MediaStream([this.localAudioTrack.getMediaStreamTrack()]));
          this.conversationState$.next('waiting');
        }
      }
    };

    this.resetChunkState();
    recorder.stop();
  }

  /** Called after API response to restart recording. */
  restartAfterProcessing(): void {
    if (!this.isConversationActive || !this.localAudioTrack) return;
    this.resetChunkState();
    this.beginRecordingChunk(new MediaStream([this.localAudioTrack.getMediaStreamTrack()]));
    this.releaseProcessingLock();
    this.startInactivityTimer();
  }

  // ── Inactivity timer ─────────────────────────────────────────────

  private startInactivityTimer(): void {
    this.clearInactivityTimer();
    this.inactivityTimer = setTimeout(() => {
      if (this.isConversationActive && !this.processingLocked) {
        this.inactivity$.next();
      }
    }, this.INACTIVITY_PROMPT_MS);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  // ── Recording ────────────────────────────────────────────────────

  private beginRecordingChunk(stream: MediaStream): void {
    const mimeType = this.preferredMimeType();
    this.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    this.audioChunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.audioChunks.push(e.data);
    };
    this.mediaRecorder.start(200);
  }

  private discardCurrentChunk(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.stop();
    }
    this.mediaRecorder = null;
    this.audioChunks = [];
  }

  private resetChunkState(): void {
    this.audioChunks = [];
    this.totalSpeechMsInChunk = 0;
    this.confirmedSpeechActive = false;
    this.speechConfirmStart = null;
    this.silenceAfterSpeechStart = null;
  }

  // ── Cleanup ──────────────────────────────────────────────────────

  private stopVAD(): void {
    if (this.vadFrameId !== null) cancelAnimationFrame(this.vadFrameId);
    this.vadFrameId = null;
    this.lastFrameTime = 0;
    this.audioContext?.close().catch(() => {});
    this.audioContext = null;
  }

  private cleanup(): void {
    this.mediaRecorder = null;
    this.localAudioTrack?.close();
    this.localAudioTrack = null;
    this.audioChunks = [];
    this.processingLocked = false;
    this.resetChunkState();
  }

  private preferredMimeType(): string {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  }
}
