import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject, Observable } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class TtsService {
  private baseUrl = environment.apiUrl;
  private currentAudio: HTMLAudioElement | null = null;
  private currentObjectUrl: string | null = null;

  /** true while the assistant is speaking */
  public speaking$ = new Subject<boolean>();

  constructor(private http: HttpClient) {}

  /**
   * Speak text aloud via OpenAI TTS.
   * Returns a promise that resolves when playback finishes (or rejects on error).
   */
  speak(text: string, language = 'vi'): Promise<void> {
    this.stop(); // cancel any ongoing speech first

    return new Promise((resolve, reject) => {
      this.http
        .post(`${this.baseUrl}/tts`, { text, language }, { responseType: 'blob' })
        .subscribe({
          next: (blob) => {
            const url = URL.createObjectURL(blob);
            this.currentObjectUrl = url;

            const audio = new Audio(url);
            this.currentAudio = audio;
            this.speaking$.next(true);

            audio.onended = () => {
              this.cleanup();
              resolve();
            };

            audio.onerror = () => {
              this.cleanup();
              reject(new Error('TTS audio playback failed'));
            };

            audio.play().catch((err) => {
              this.cleanup();
              reject(err);
            });
          },
          error: (err) => {
            reject(err);
          }
        });
    });
  }

  /** Stop any currently playing TTS audio immediately. */
  stop(): void {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
      this.currentAudio = null;
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
    this.currentAudio = null;
    this.speaking$.next(false);
  }
}
