import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ApiService } from '../../services/api.service';

type VoiceState = 'Idle' | 'Listening' | 'Thinking' | 'Missing Info' | 'Success' | 'Error';

@Component({
  selector: 'app-voice-invoice',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './voice-invoice.component.html',
  styleUrl: './voice-invoice.component.scss'
})
export class VoiceInvoiceComponent {
  state: VoiceState = 'Idle';
  invoiceForm: FormGroup;
  statusMessage: string = 'Awaiting voice command...';

  constructor(private fb: FormBuilder, private apiService: ApiService) {
    this.invoiceForm = this.fb.group({
      clientName: ['', Validators.required],
      amount: [null, [Validators.required, Validators.min(1)]],
      description: ['', Validators.required]
    });
  }

  simulateVoiceCommand() {
    this.state = 'Listening';
    this.statusMessage = 'Listening for "Create an invoice for Acme Corp for 500 dollars..."';
    
    // Simulate Agora SDK processing delay
    setTimeout(() => {
      this.state = 'Thinking';
      this.statusMessage = 'Processing speech via simulated Agora / LLM...';
      
      // Simulate mapping transcript to JSON
      setTimeout(() => {
        this.state = 'Success';
        this.statusMessage = 'Voice processed successfully! Please review the invoice.';
        this.invoiceForm.patchValue({
          clientName: 'Acme Corp',
          amount: 500,
          description: 'Web development services'
        });
      }, 1500);
    }, 1500);
  }

  submitInvoice() {
    if (this.invoiceForm.invalid) return;

    this.apiService.createInvoice(this.invoiceForm.value).subscribe({
      next: (res) => {
        this.statusMessage = 'Invoice successfully created in backend!';
        this.state = 'Idle';
        this.invoiceForm.reset();
      },
      error: (err) => {
        this.statusMessage = 'Failed to create invoice: ' + (err.error?.message || err.message);
        this.state = 'Error';
      }
    });
  }
}
