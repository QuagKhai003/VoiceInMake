import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VoiceService } from '../../services/voice.service';
import { ApiService } from '../../services/api.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-voice-interface',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './voice-interface.component.html',
  styleUrl: './voice-interface.component.scss'
})
export class VoiceInterfaceComponent implements OnInit, OnDestroy {
  @Input() currentContext: any = {};
  @Output() aiResponse = new EventEmitter<any>();
  @Output() stateChange = new EventEmitter<'Idle' | 'Listening' | 'Processing' | 'Error'>();

  isRecording = false;
  isProcessing = false;
  statusMessage = 'Hold to Speak or Click to Start';
  error: string | null = null;

  private recordingSub!: Subscription;
  private audioSub!: Subscription;
  private errorSub!: Subscription;

  constructor(private voiceService: VoiceService, private apiService: ApiService) {}

  ngOnInit() {
    this.stateChange.emit('Idle');
    this.recordingSub = this.voiceService.recordingState$.subscribe(state => {
      this.isRecording = state;
      if (state) {
        this.updateStatus('Listening...');
        this.clearError();
        this.stateChange.emit('Listening');
      } else {
        this.statusMessage = 'Processing AI...';
      }
    });

    this.audioSub = this.voiceService.audioBlob$.subscribe(blob => {
      this.processAudio(blob);
    });

    this.errorSub = this.voiceService.error$.subscribe(err => {
      this.error = err;
      this.isRecording = false;
      this.statusMessage = 'Error accessing microphone';
      this.stateChange.emit('Error');
    });
  }

  ngOnDestroy() {
    if (this.recordingSub) this.recordingSub.unsubscribe();
    if (this.audioSub) this.audioSub.unsubscribe();
    if (this.errorSub) this.errorSub.unsubscribe();
  }

  toggleRecording() {
    if (this.isRecording) {
      this.voiceService.stopRecording();
    } else {
      this.voiceService.startRecording();
    }
  }

  startRecording() {
    this.voiceService.startRecording();
  }

  stopRecording() {
    this.voiceService.stopRecording();
  }

  private processAudio(blob: Blob) {
    this.isProcessing = true;
    this.stateChange.emit('Processing');
    this.statusMessage = 'Processing AI...';

    this.apiService.processVoice(blob, this.currentContext).subscribe({
      next: (response) => {
        this.isProcessing = false;
        this.statusMessage = response.message || 'Voice processed successfully!';
        this.stateChange.emit('Idle');
        this.aiResponse.emit(response);
      },
      error: (err) => {
        this.isProcessing = false;
        this.error = 'Failed to process voice command: ' + (err.error?.message || err.message);
        this.statusMessage = 'Hold to Speak or Click to Start';
        this.stateChange.emit('Error');
      }
    });
  }

  private updateStatus(message: string) {
    this.statusMessage = message;
  }

  private clearError() {
    this.error = null;
  }
}
