import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private baseUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  healthCheck(): Observable<any> {
    return this.http.get(`${this.baseUrl}/health`);
  }

  createInvoice(data: any): Observable<any> {
    return this.http.post(`${this.baseUrl}/invoice`, data);
  }

  processVoice(audioBlob: Blob, currentContext: any = {}, language: string = 'vi'): Observable<any> {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'voice.webm');
    formData.append('context', JSON.stringify(currentContext));
    formData.append('language', language);

    return this.http.post(`${this.baseUrl}/voice`, formData);
  }

  processText(transcript: string, currentContext: any = {}, language: string = 'vi'): Observable<any> {
    return this.http.post(`${this.baseUrl}/voice/text`, {
      transcript,
      context: currentContext,
      language
    });
  }

  planAssistant(invoiceContext: any, websiteContext: string, transcript?: string): Observable<any> {
    const payload: any = {
      invoiceContext,
      websiteContext: websiteContext.trim()
    };

    if (transcript) {
      payload.transcript = transcript;
    }

    return this.http.post(`${this.baseUrl}/assistant/plan`, payload);
  }
}
