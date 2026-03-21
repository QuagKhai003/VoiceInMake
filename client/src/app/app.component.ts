import { Component, OnInit, AfterViewChecked, ElementRef, ViewChild, OnDestroy } from '@angular/core';
import { CommonModule, KeyValuePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterOutlet } from '@angular/router';
import { ApiService } from './services/api.service';
import { TtsService } from './services/tts.service';
import { WebSpeechService } from './services/web-speech.service';
import { VoiceInterfaceComponent } from './components/voice-interface/voice-interface.component';
import { InvoiceContextLogComponent } from './components/invoice-context-log/invoice-context-log.component';
import { Subscription } from 'rxjs';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  extractedFields?: { [key: string]: any };
  missingFields?: string[];
  timestamp: Date;
}

type AssistantState = 'Idle' | 'Listening' | 'Processing' | 'Needs Info' | 'Ready' | 'Error';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterOutlet, VoiceInterfaceComponent, InvoiceContextLogComponent, KeyValuePipe],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit, AfterViewChecked, OnDestroy {
  @ViewChild('chatScroll') private chatScroll!: ElementRef<HTMLDivElement>;

  title = 'VoiceInMake';
  backendStatus = 'Checking...';
  assistantState: AssistantState = 'Idle';
  submissionMessage: string | null = null;

  masterContext: { [key: string]: any } = {};
  missingFields: string[] = [];
  recommendedActions: any[] = [];
  chatMessages: ChatMessage[] = [];
  showContextPanel = false;
  isSpeaking = false;
  ttsEnabled = true;
  private shouldScrollChat = false;
  private lastTranscript = '';
  private speakingSub!: Subscription;

  readonly fieldLabels: { [key: string]: string } = {
    buyerName:    'Tên người mua',
    taxId:        'Mã số thuế',
    vatNumber:    'Số VAT',
    buyerAddress: 'Địa chỉ',
    invoiceType:  'Loại hóa đơn',
    issueDate:    'Ngày phát hành',
    lineItems:    'Hàng hóa / dịch vụ'
  };

  constructor(
    private apiService: ApiService,
    private ttsService: TtsService,
    private webSpeech: WebSpeechService
  ) {}

  ngOnInit(): void {
    this.apiService.healthCheck().subscribe({
      next: () => { this.backendStatus = 'Backend OK'; },
      error: ()  => { this.backendStatus = 'Backend Offline'; }
    });

    // Track TTS speaking state
    this.speakingSub = this.ttsService.speaking$.subscribe((s) => (this.isSpeaking = s));

    // Inactivity: nudge user when mic is open but silent
    this.webSpeech.inactivity$.subscribe(() => this.promptNextMissingField());

    // Barge-in: user spoke while AI was talking — cut TTS immediately
    this.webSpeech.bargeIn$.subscribe(() => {
      this.ttsService.stop();
      this.isSpeaking = false;
    });

    // Greeting
    const greeting = 'Xin chào! Tôi là trợ lý hoá đơn của bạn. Nhấn nút mic và nói để bắt đầu.';
    this.pushAssistantMessage(
      greeting + '\nHello! I\'m your invoice assistant. Press the mic and speak to begin.',
      [], []
    );
    this.speak(greeting, 'vi');
  }

  ngOnDestroy(): void {
    this.speakingSub?.unsubscribe();
    this.ttsService.stop();
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollChat) {
      this.scrollChatToBottom();
      this.shouldScrollChat = false;
    }
  }

  // ── Voice events ──────────────────────────────────────────────────

  handleAiResponse(response: any): void {
    if (response.transcript) {
      this.lastTranscript = response.transcript;
      this.chatMessages.push({ role: 'user', text: response.transcript, timestamp: new Date() });
    }

    if (response.extractedEntities) {
      this.masterContext = { ...this.masterContext, ...response.extractedEntities };
    }
    this.missingFields = response.missingFields ?? [];

    const assistantText = response.assistantResponse ?? response.message ?? '';
    const lang = response.language ?? 'vi';
    if (assistantText) {
      this.pushAssistantMessage(assistantText, response.extractedEntities ?? {}, this.missingFields, lang);
    }

    if (response.intent === 'submit') {
      this.assistantState = 'Ready';
      this.submitInvoice();
      return;
    }

    this.assistantState = this.missingFields.length > 0 ? 'Needs Info' : 'Ready';
    this.shouldScrollChat = true;

    // Request planning guidance (fires in parallel with TTS)
    this.apiService.planAssistant(this.masterContext, '', this.lastTranscript).subscribe({
      next: (plan) => {
        this.recommendedActions = plan?.recommendedActions ?? [];
        if (plan?.assistantResponse && plan.assistantResponse !== assistantText) {
          this.pushAssistantMessage(plan.assistantResponse, {}, plan.missingFields ?? []);
        }
      },
      error: () => {}
    });
  }

  handleStateChange(state: AssistantState): void {
    if (['Listening', 'Processing', 'Idle', 'Error'].includes(state)) {
      this.assistantState = state;
    }
  }

  handleContextChange(updatedContext: { [key: string]: any }): void {
    this.masterContext = { ...updatedContext };
  }

  // ── Submit ────────────────────────────────────────────────────────

  submitInvoice(): void {
    this.apiService.createInvoice(this.masterContext).subscribe({
      next: () => {
        this.masterContext = {};
        this.missingFields = [];
        this.recommendedActions = [];
        this.assistantState = 'Idle';
        this.chatMessages = [];
        this.pushAssistantMessage(
          'Hoá đơn đã gửi! Bạn có muốn tạo hoá đơn mới không?\nInvoice submitted! Would you like to create another?',
          [], []
        );
        this.shouldScrollChat = true;
      },
      error: (err) => {
        const msg = err.error?.message || err.message || 'Unknown error';
        this.pushSystemMessage(`❌ Lỗi tạo hoá đơn: ${msg}`);
      }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private pushAssistantMessage(text: string, extractedFields: any, missingFields: string[], lang = 'vi'): void {
    this.chatMessages.push({ role: 'assistant', text, extractedFields, missingFields, timestamp: new Date() });
    this.shouldScrollChat = true;
    this.speak(text, lang);
  }

  /** Speak text aloud; pause Web Speech recognition during playback, resume when done. */
  private speak(text: string, language = 'vi'): void {
    if (!this.ttsEnabled || !text.trim()) {
      // Even if TTS is off, let the recognition service know AI "finished" so it resumes
      this.webSpeech.processingDone();
      return;
    }

    this.webSpeech.aiStartedSpeaking();

    this.ttsService.speak(text, language).then(() => {
      this.webSpeech.aiFinishedSpeaking();
    }).catch(() => {
      this.webSpeech.aiFinishedSpeaking();
    });
  }

  /** Called when mic is open but user has been silent for inactivity threshold. */
  private promptNextMissingField(): void {
    if (this.assistantState === 'Processing') return;
    this.apiService.planAssistant(this.masterContext, '', this.lastTranscript).subscribe({
      next: (plan) => {
        const text = plan?.assistantResponse;
        if (!text) return;
        const last = this.chatMessages[this.chatMessages.length - 1];
        if (last?.role === 'assistant' && last.text === text) {
          this.speak(text, 'vi');
        } else {
          this.pushAssistantMessage(text, {}, plan.missingFields ?? []);
        }
      },
      error: () => {}
    });
  }

  private pushSystemMessage(text: string): void {
    this.chatMessages.push({ role: 'system', text, timestamp: new Date() });
    this.shouldScrollChat = true;
  }

  private scrollChatToBottom(): void {
    try {
      const el = this.chatScroll?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    } catch {}
  }

  get filledFields(): { key: string; label: string; value: any }[] {
    return Object.entries(this.masterContext)
      .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => ({ key: k, label: this.fieldLabel(k), value: v }));
  }

  get hasContext(): boolean {
    return this.filledFields.length > 0;
  }

  get assistantStateClass(): string {
    return this.assistantState.toLowerCase().replace(/\s+/g, '-');
  }

  fieldLabel(key: string): string {
    return this.fieldLabels[key] || key;
  }

  extractedEntries(obj: any): { key: string; value: any }[] {
    if (!obj || typeof obj !== 'object') return [];
    return Object.entries(obj)
      .filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => ({ key: this.fieldLabel(k), value: v }));
  }
}
