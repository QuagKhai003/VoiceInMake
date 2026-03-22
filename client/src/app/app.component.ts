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
  displayText?: string;        // text revealed so far (typing effect)
  isTyping?: boolean;           // true while typing animation is active
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
  automationContext: { websiteUrl?: string; username?: string; password?: string } = {};
  missingFields: string[] = [];
  recommendedActions: any[] = [];
  chatMessages: ChatMessage[] = [];
  showContextPanel = false;
  isSpeaking = false;
  ttsEnabled = true;
  liveInterimText = '';
  liveInterimFinal = false;
  automationRunning = false;
  automationStatus = '';
  textInput = '';
  private shouldScrollChat = false;
  private lastTranscript = '';
  private speakingSub!: Subscription;
  private typingTimer: any = null;
  private eventSource: EventSource | null = null;

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

    // Barge-in: user spoke while AI was talking — cut TTS and finish typing
    this.webSpeech.bargeIn$.subscribe(() => {
      this.ttsService.stop();
      this.isSpeaking = false;
      this.finishTyping();
    });

    // Greeting
    const greeting = 'Xin chào! Tôi là trợ lý hoá đơn của bạn. Nhấn nút mic và nói để bắt đầu.';
    this.pushAssistantMessage(greeting, [], []);
  }

  ngOnDestroy(): void {
    this.speakingSub?.unsubscribe();
    this.ttsService.stop();
    this.finishTyping();
    this.stopAutomationListener();
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollChat) {
      this.scrollChatToBottom();
      this.shouldScrollChat = false;
    }
  }

  // ── Text input ──────────────────────────────────────────────────

  sendTextInput(): void {
    const text = this.textInput.trim();
    if (!text) return;
    this.textInput = '';
    this.chatMessages.push({ role: 'user', text, timestamp: new Date() });
    this.shouldScrollChat = true;

    // If automation is running, send as instruction to the agent
    if (this.automationRunning) {
      this.apiService.sendInstruction(text).subscribe({
        error: (err) => {
          this.pushSystemMessage(`❌ ${err.error?.message || err.message || 'Lỗi gửi hướng dẫn'}`);
        }
      });
      return;
    }

    this.assistantState = 'Processing';
    this.apiService.processText(text, this.masterContext, 'vi', this.automationContext).subscribe({
      next: (response) => {
        this.handleAiResponse({ ...response, transcript: undefined });
      },
      error: (err) => {
        this.pushSystemMessage(`❌ ${err.error?.message || err.message || 'Lỗi xử lý'}`);
        this.assistantState = 'Idle';
      }
    });
  }

  // ── Voice events ──────────────────────────────────────────────────

  handleAiResponse(response: any): void {
    // If automation is running and we got a voice transcript, forward it as instruction
    if (this.automationRunning && response.transcript) {
      this.chatMessages.push({ role: 'user', text: response.transcript, timestamp: new Date() });
      this.liveInterimText = '';
      this.liveInterimFinal = false;
      this.shouldScrollChat = true;
      this.apiService.sendInstruction(response.transcript).subscribe();
      this.webSpeech.processingDone();
      return;
    }

    if (response.transcript) {
      this.lastTranscript = response.transcript;
      this.liveInterimText = '';
      this.liveInterimFinal = false;
      this.chatMessages.push({ role: 'user', text: response.transcript, timestamp: new Date() });
    }

    if (response.extractedEntities) {
      this.masterContext = { ...response.extractedEntities };
    }

    // Merge automation fields (website URL, credentials)
    if (response.automationFields) {
      const auto = response.automationFields;
      if (auto.websiteUrl) this.automationContext.websiteUrl = auto.websiteUrl;
      if (auto.username) this.automationContext.username = auto.username;
      if (auto.password) this.automationContext.password = auto.password;
    }

    const assistantText = response.assistantResponse ?? '';
    const lang = response.language ?? 'vi';
    if (assistantText) {
      this.pushAssistantMessage(assistantText, response.extractedEntities ?? {}, [], lang);
    }

    // Start browser automation when we have all info
    if (response.intent === 'start_automation') {
      this.startAutomation();
      return;
    }

    this.assistantState = 'Idle';
    this.shouldScrollChat = true;
  }

  handleInterimTranscript(event: { text: string; isFinal: boolean }): void {
    this.liveInterimText = event.text;
    this.liveInterimFinal = event.isFinal;
    this.shouldScrollChat = true;
  }

  handleStateChange(state: AssistantState): void {
    if (['Listening', 'Processing', 'Idle', 'Error'].includes(state)) {
      this.assistantState = state;
    }
  }

  handleContextChange(updatedContext: { [key: string]: any }): void {
    this.masterContext = { ...updatedContext };
  }

  // ── Automation ──────────────────────────────────────────────────────

  startAutomation(): void {
    const { websiteUrl, username, password } = this.automationContext;
    if (!websiteUrl || !username || !password) {
      this.pushAssistantMessage('Chưa đủ thông tin để tự động hóa. Vui lòng cung cấp URL, tên đăng nhập và mật khẩu.', {}, []);
      return;
    }

    this.automationRunning = true;
    this.assistantState = 'Processing';
    this.pushAssistantMessage('Đang bắt đầu tự động điền hóa đơn trên website...', {}, []);

    // Trigger the automation FIRST, then connect SSE (so resetAgent() runs before getAgent())
    this.apiService.startAutomation(websiteUrl, { username, password }, this.masterContext).subscribe({
      next: () => {
        // Now connect SSE — agent is already created by resetAgent()
        this.connectAutomationSSE();
      },
      error: (err) => {
        this.pushSystemMessage(`❌ Lỗi: ${err.error?.message || err.message}`);
        this.automationRunning = false;
        this.assistantState = 'Idle';
      }
    });
  }

  private connectAutomationSSE(): void {
    this.eventSource = this.apiService.automationEvents();
    this.eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.automationStatus = data.status || '';
      this.shouldScrollChat = true;

      if (data.event === 'status' || data.event === 'action') {
        this.pushSystemMessage(`🤖 ${data.status}`);
      } else if (data.event === 'ask_user') {
        this.pushAssistantMessage(data.question || data.status, {}, [], 'vi');
        this.assistantState = 'Needs Info';
      } else if (data.event === 'done') {
        this.pushAssistantMessage(data.status, {}, []);
        this.stopAutomationListener();
        this.automationRunning = false;
        this.assistantState = 'Idle';
      } else if (data.event === 'error') {
        this.pushSystemMessage(`❌ ${data.status}`);
      }
    };
    this.eventSource.onerror = () => {
      this.stopAutomationListener();
      this.automationRunning = false;
      this.assistantState = 'Idle';
    };
  }

  stopAutomation(): void {
    this.apiService.stopAutomation().subscribe();
    this.stopAutomationListener();
    this.automationRunning = false;
    this.assistantState = 'Idle';
  }

  private stopAutomationListener(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
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
          'Hoá đơn đã gửi thành công! Bạn có muốn tạo hoá đơn mới không?',
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
    // Stop any previous typing animation
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
      // Finish any previously typing message
      const prev = this.chatMessages.find(m => m.isTyping);
      if (prev) { prev.displayText = prev.text; prev.isTyping = false; }
    }

    const msg: ChatMessage = {
      role: 'assistant', text, displayText: '', isTyping: true,
      extractedFields, missingFields, timestamp: new Date()
    };
    this.chatMessages.push(msg);
    this.shouldScrollChat = true;

    // Typing animation: reveal characters over the duration of TTS
    let charIndex = 0;
    const charsPerTick = 2;
    const intervalMs = 40;
    this.typingTimer = setInterval(() => {
      charIndex = Math.min(charIndex + charsPerTick, text.length);
      msg.displayText = text.slice(0, charIndex);
      this.shouldScrollChat = true;
      if (charIndex >= text.length) {
        clearInterval(this.typingTimer);
        this.typingTimer = null;
        msg.isTyping = false;
      }
    }, intervalMs);

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

  private finishTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    const msg = this.chatMessages.find(m => m.isTyping);
    if (msg) { msg.displayText = msg.text; msg.isTyping = false; }
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
