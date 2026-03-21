import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { ApiService } from './services/api.service';
import { VoiceInterfaceComponent } from './components/voice-interface/voice-interface.component';
import { InvoiceContextLogComponent } from './components/invoice-context-log/invoice-context-log.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, VoiceInterfaceComponent, InvoiceContextLogComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {
  title = 'VoiceInMake';
  backendStatus: string = 'Checking...';
  
  // The master memory object built up by voice interactions
  masterContext: { [key: string]: any } = {};
  submissionMessage: string | null = null;

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
    // Merge new entities into the master context
    if (response.extractedEntities) {
      this.masterContext = { ...this.masterContext, ...response.extractedEntities };
    }

    // If the AI determined the user wants to submit, do it automatically
    if (response.intent === 'submit') {
      this.submitInvoice();
    }
  }

  submitInvoice() {
    this.apiService.createInvoice(this.masterContext).subscribe({
      next: (res) => {
        this.submissionMessage = 'Invoice successfully created!';
        this.masterContext = {}; // Clear context on success
        setTimeout(() => this.submissionMessage = null, 5000);
      },
      error: (err) => {
        console.error('Submission failed', err);
        alert('Failed to submit invoice: ' + (err.error?.message || err.message));
      }
    });
  }
}
