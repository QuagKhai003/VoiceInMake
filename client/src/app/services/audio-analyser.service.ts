import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AudioAnalyserService {
  public amplitude$ = new BehaviorSubject<number>(0);

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private buffer: Uint8Array | null = null;

  async start(): Promise<void> {
    if (this.audioContext) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0;
      this.buffer = new Uint8Array(this.analyser.fftSize);
      this.audioContext.createMediaStreamSource(this.stream).connect(this.analyser);
      this.tick();
    } catch {
      // mic permission denied or not available — fail silently, visualization just won't work
    }
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.buffer = null;
    this.amplitude$.next(0);
  }

  private tick(): void {
    if (!this.analyser || !this.buffer) return;
    this.analyser.getByteTimeDomainData(this.buffer);
    let peak = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const v = Math.abs(this.buffer[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    this.amplitude$.next(peak);
    this.rafId = requestAnimationFrame(() => this.tick());
  }
}
