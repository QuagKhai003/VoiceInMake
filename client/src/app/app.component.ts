import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterOutlet } from '@angular/router';
import { ApiService } from './services/api.service';
import { VoiceInterfaceComponent } from './components/voice-interface/voice-interface.component';
import { InvoiceContextLogComponent } from './components/invoice-context-log/invoice-context-log.component';

type AssistantState = 'Idle' | 'Listening' | 'Processing' | 'Needs Info' | 'Ready' | 'Error';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterOutlet, VoiceInterfaceComponent, InvoiceContextLogComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {
  title = 'VoiceInMake';
  backendStatus: string = 'Checking...';
  
  // The master memory object built up by voice interactions
  masterContext: { [key: string]: any } = {};
  submissionMessage: string | null = null;
  assistantState: AssistantState = 'Idle';
  assistantMessage: string = 'Ready for your next instruction.';
  missingFields: string[] = [];
  recommendedActions: string[] = [];
  websiteContext: string = '';
  planLoading = false;
  planError: string | null = null;
  private lastTranscript: string = '';

  constructor(private apiService: ApiService) {}

  ngOnInit(): void {
    this.apiService.healthCheck().subscribe({
      next: (res) => {
        this.backendStatus = `Backend OK (${res.timestamp})`;
      },
      error: () => {
        this.backendStatus = 'Backend Offline';
      }
    });
  }

  handleAiResponse(response: any) {
    if (response.extractedEntities) {
      this.masterContext = { ...this.masterContext, ...response.extractedEntities };
    }

    this.missingFields = response.missingFields ?? [];
    this.assistantMessage = response.assistantResponse ?? this.assistantMessage;
    this.lastTranscript = response.transcript ?? '';

    if (response.intent === 'submit') {
      this.assistantState = 'Ready';
      this.submitInvoice();
      return;
    }

    this.assistantState = this.missingFields.length > 0 ? 'Needs Info' : 'Ready';
    this.requestPlanning(this.lastTranscript);
  }

  submitInvoice() {
    this.apiService.createInvoice(this.masterContext).subscribe({
      next: (res) => {
        this.submissionMessage = 'Invoice successfully created!';
        this.masterContext = {}; // Clear context on success
        this.assistantState = 'Idle';
        this.missingFields = [];
        this.recommendedActions = [];
        this.assistantMessage = 'Invoice submitted. Ready for another request.';
        setTimeout(() => this.submissionMessage = null, 5000);
      },
      error: (err) => {
        console.error('Submission failed', err);
        alert('Failed to submit invoice: ' + (err.error?.message || err.message));
      }
    });
  }

  handleStateChange(state: AssistantState) {
    if (state === 'Listening' || state === 'Processing' || state === 'Idle' || state === 'Error') {
      this.assistantState = state;
    }
  }

  handleContextChange(updatedContext: { [key: string]: any }) {
    this.masterContext = { ...updatedContext };
    this.requestPlanning();
  }

  requestPlanning(transcript?: string) {
    this.planLoading = true;
    this.planError = null;

    this.apiService.planAssistant(this.masterContext, this.websiteContext, transcript ?? this.lastTranscript).subscribe({
      next: (plan) => {
        this.recommendedActions = plan?.recommendedActions ?? [];
        if (plan?.assistantResponse) {
          this.assistantMessage = plan.assistantResponse;
        }
        this.planLoading = false;
      },
      error: (err) => {
        console.error('Planning failure', err);
        this.planError = err.error?.message || err.message;
        this.planLoading = false;
      }
    });
  }

  get assistantStateClass(): string {
    return this.assistantState.toLowerCase().replace(/\s+/g, '-');
  }
}
