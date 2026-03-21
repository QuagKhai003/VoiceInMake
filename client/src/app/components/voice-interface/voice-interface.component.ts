import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WebSpeechService, SpeechState } from '../../services/web-speech.service';
import { ApiService } from '../../services/api.service';
import { AudioAnalyserService } from '../../services/audio-analyser.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-voice-interface',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './voice-interface.component.html',
  styleUrl: './voice-interface.component.scss'
})
export class VoiceInterfaceComponent implements OnInit, OnDestroy {
  @Input() currentContext: any = {};
  @Output() aiResponse = new EventEmitter<any>();
  @Output() stateChange = new EventEmitter<'Idle' | 'Listening' | 'Processing' | 'Error'>();
  @Output() interimTranscript = new EventEmitter<{ text: string; isFinal: boolean }>();

  conversationActive = false;
  speechState: SpeechState = 'inactive';
  interimText = '';             // live partial transcript shown while user speaks
  isFinalTranscript = false;
  amplitude = 0;
  error: string | null = null;
  selectedLanguage: 'vi' | 'en' | 'auto' = 'vi';

  private subs: Subscription[] = [];

  constructor(
    public webSpeech: WebSpeechService,
    private apiService: ApiService,
    private audioAnalyser: AudioAnalyserService
  ) {}

  ngOnInit(): void {
    this.stateChange.emit('Idle');

    this.subs.push(
      this.webSpeech.state$.subscribe((state) => {
        this.speechState = state;
        if (state === 'inactive') {
          this.conversationActive = false;
          this.stateChange.emit('Idle');
        } else if (state === 'listening' || state === 'capturing' || state === 'speaking') {
          this.stateChange.emit('Listening');
        } else if (state === 'processing') {
          this.stateChange.emit('Processing');
        }
      }),

      this.webSpeech.transcript$.subscribe(({ text, isFinal }) => {
        this.interimText = text;
        this.isFinalTranscript = isFinal;
        this.interimTranscript.emit({ text, isFinal });
      }),

      this.webSpeech.finalTranscript$.subscribe((transcript) => {
        this.interimText = '';
        this.isFinalTranscript = false;
        this.sendTranscript(transcript);
      }),

      this.webSpeech.error$.subscribe((err) => {
        this.error = err;
        this.conversationActive = false;
        this.stateChange.emit('Error');
      }),

      this.audioAnalyser.amplitude$.subscribe(v => (this.amplitude = v))
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    if (this.conversationActive) {
      this.webSpeech.stop();
    }
    this.audioAnalyser.stop();
  }

  toggleConversation(): void {
    if (this.conversationActive) {
      this.webSpeech.stop();
      this.audioAnalyser.stop();
      this.conversationActive = false;
      this.interimText = '';
    } else {
      if (!this.webSpeech.isSupported) {
        this.error = 'Nhận dạng giọng nói yêu cầu trình duyệt Chrome. Vui lòng mở bằng Chrome.';
        return;
      }
      this.error = null;
      this.conversationActive = true;
      this.audioAnalyser.start();
      this.webSpeech.start(this.selectedLanguage);
    }
  }

  get statusLabel(): string {
    if (!this.conversationActive) return 'Nhấn 🎙 để bắt đầu';
    switch (this.speechState) {
      case 'listening':   return '👂 Đang lắng nghe...';
      case 'capturing':   return '🎙 Đang ghi âm...';
      case 'processing':  return '🤖 Đang phân tích...';
      case 'speaking':    return '🔊 Trợ lý đang nói...';
      default:            return 'Sẵn sàng';
    }
  }

  get sessionStateClass(): string {
    return this.speechState;
  }

  private sendTranscript(transcript: string): void {
    this.apiService.processText(transcript, this.currentContext, this.selectedLanguage).subscribe({
      next: (response) => {
        this.aiResponse.emit(response);
        // webSpeech.processingDone() will be called by the parent after TTS finishes
      },
      error: (err) => {
        this.error = err.error?.message || err.message || 'Không thể xử lý giọng nói.';
        this.stateChange.emit('Error');
        this.webSpeech.processingDone();
      }
    });
  }
}
