import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

// Web Speech API types (not always in TypeScript's default lib.dom.d.ts)
interface ISpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((event: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: any) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
declare const SpeechRecognition: new () => ISpeechRecognition;
declare const webkitSpeechRecognition: new () => ISpeechRecognition;

export type SpeechState =
  | 'inactive'    // not started
  | 'listening'   // waiting for user to speak
  | 'capturing'   // user is speaking (interim results coming in)
  | 'processing'  // sent to backend, waiting for AI
  | 'speaking';   // AI is talking (still listening for barge-in)

@Injectable({ providedIn: 'root' })
export class WebSpeechService {
  // ── Public streams ────────────────────────────────────────────────
  /** Fires on every interim or final transcript from the browser STT. */
  public transcript$ = new Subject<{ text: string; isFinal: boolean }>();
  /** Fires when a final transcript is ready to send to the AI. */
  public finalTranscript$ = new Subject<string>();
  /** Current state for UI binding. */
  public state$ = new Subject<SpeechState>();
  /** Non-fatal errors (no-speech, network). */
  public error$ = new Subject<string>();
  /** User spoke while AI was talking — caller should stop TTS. */
  public bargeIn$ = new Subject<void>();
  /** Mic open but silent for INACTIVITY_MS. */
  public inactivity$ = new Subject<void>();

  private readonly INACTIVITY_MS = 10_000;

  private recognition: ISpeechRecognition | null = null;
  private active = false;
  private aiTalking = false;  // true while TTS is playing
  private lang = 'vi-VN';
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFinal = '';  // accumulate across recognition sessions in one turn
  private hasFiredFinal = false; // guard: only send once per turn
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SILENCE_DELAY_MS = 1800; // wait 1.8s of silence before sending

  // ── Public API ────────────────────────────────────────────────────

  get isSupported(): boolean {
    return !!(
      typeof window !== 'undefined' &&
      ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)
    );
  }

  start(lang: 'vi' | 'en' | 'auto' = 'vi'): void {
    if (this.active) return;
    if (!this.isSupported) {
      this.error$.next('Speech recognition is not supported in this browser. Use Chrome.');
      return;
    }
    this.lang = lang === 'vi' ? 'vi-VN' : lang === 'en' ? 'en-US' : 'vi-VN';
    this.active = true;
    this.aiTalking = false;
    this.startRecognition();
    this.resetInactivityTimer();
  }

  stop(): void {
    this.active = false;
    this.aiTalking = false;
    this.clearInactivityTimer();
    this.clearSilenceTimer();
    this.recognition?.abort();
    this.recognition = null;
    this.pendingFinal = '';
    this.hasFiredFinal = false;
    this.state$.next('inactive');
  }

  /** Call when AI starts speaking — keeps recognition running to catch barge-in. */
  aiStartedSpeaking(): void {
    this.aiTalking = true;
    this.state$.next('speaking');
    this.clearInactivityTimer();
    this.clearSilenceTimer();
    // Ensure recognition is running so we can detect barge-in
    if (this.active && (!this.recognition || this.isRecognitionStopped())) {
      this.startRecognition();
    }
  }

  /** Call when AI finishes speaking — user's turn again. */
  aiFinishedSpeaking(): void {
    this.aiTalking = false;
    this.pendingFinal = '';
    this.hasFiredFinal = false;
    this.state$.next('listening');
    this.resetInactivityTimer();
    // Ensure recognition is running
    if (this.active && (!this.recognition || this.isRecognitionStopped())) {
      this.startRecognition();
    }
  }

  /** Call when backend response is received — ready for next user turn. */
  processingDone(): void {
    this.pendingFinal = '';
    this.hasFiredFinal = false;
    if (this.active && !this.aiTalking) {
      this.state$.next('listening');
      this.resetInactivityTimer();
      if (this.isRecognitionStopped()) {
        this.startRecognition();
      }
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  private startRecognition(): void {
    const SR: (new () => ISpeechRecognition) =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    const r = new SR();
    r.lang = this.lang;
    r.continuous = true;        // keep listening — we control when to send via silence timer
    r.interimResults = true;
    r.maxAlternatives = 1;
    this.recognition = r;

    r.onstart = () => {
      if (!this.aiTalking) {
        this.state$.next('listening');
      }
    };

    r.onspeechstart = () => {
      this.clearInactivityTimer();
      if (this.aiTalking) {
        // Barge-in: user spoke while AI was talking
        this.aiTalking = false;
        this.bargeIn$.next();
      }
      this.state$.next('capturing');
    };

    r.onresult = (event: any) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += text;
        } else {
          interim += text;
        }
      }

      if (interim) {
        this.transcript$.next({ text: (this.pendingFinal ? this.pendingFinal + ' ' : '') + interim, isFinal: false });
        // User is still talking — reset silence timer
        this.resetSilenceTimer();
      }
      if (finalText) {
        this.pendingFinal += (this.pendingFinal ? ' ' : '') + finalText;
        this.transcript$.next({ text: this.pendingFinal, isFinal: true });
        // Got a final chunk but user might continue — start silence timer
        this.resetSilenceTimer();
      }
    };

    r.onspeechend = () => {
      // Speech paused — silence timer will handle sending if user doesn't continue
    };

    r.onend = () => {
      this.recognition = null;
      if (!this.active) return;

      // continuous mode can still end (timeout, error) — restart if we haven't sent yet
      if (!this.hasFiredFinal) {
        if (this.pendingFinal.trim()) {
          // We have accumulated text — start silence timer to send
          this.resetSilenceTimer();
        }
        // Restart recognition to keep listening
        setTimeout(() => {
          if (this.active && !this.hasFiredFinal) this.startRecognition();
        }, 150);
      }
    };

    r.onerror = (event: any) => {
      this.recognition = null;
      if (event.error === 'no-speech' || event.error === 'audio-capture') {
        // Silent restart
        return;
      }
      if (event.error === 'not-allowed') {
        this.error$.next('Microphone permission denied. Please allow microphone access.');
        this.active = false;
        this.state$.next('inactive');
        return;
      }
      // Other errors: log and restart
      console.warn('SpeechRecognition error:', event.error);
    };

    try {
      r.start();
    } catch {
      // Already started — ignore
    }
  }

  private isRecognitionStopped(): boolean {
    // No reliable readyState on SpeechRecognition — assume stopped if null
    return this.recognition === null;
  }

  // ── Silence timer (delay before sending final transcript) ────────

  private resetSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.fireFinalTranscript();
    }, this.SILENCE_DELAY_MS);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private fireFinalTranscript(): void {
    this.clearSilenceTimer();
    const text = this.pendingFinal.trim();
    if (text && !this.hasFiredFinal) {
      this.hasFiredFinal = true;
      this.pendingFinal = '';
      this.state$.next('processing');
      this.finalTranscript$.next(text);
      // Keep recognition running — don't abort. It will keep capturing
      // if user speaks again (barge-in) or stay silent.
    }
  }

  // ── Inactivity ────────────────────────────────────────────────────

  private resetInactivityTimer(): void {
    this.clearInactivityTimer();
    this.inactivityTimer = setTimeout(() => {
      if (this.active && !this.aiTalking) {
        this.inactivity$.next();
      }
    }, this.INACTIVITY_MS);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }
}
