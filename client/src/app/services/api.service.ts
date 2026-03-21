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

  processVoice(audioBlob: Blob, currentContext: any = {}): Observable<any> {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'voice.webm');
    formData.append('context', JSON.stringify(currentContext));

    return this.http.post(`${this.baseUrl}/voice`, formData);
  }
}
