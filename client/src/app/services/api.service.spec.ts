import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { ApiService } from './api.service';
import { environment } from '../../environments/environment';

describe('ApiService', () => {
  let service: ApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ApiService, provideHttpClient(), provideHttpClientTesting()]
    });

    service = TestBed.inject(ApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('sends voice audio and context to /voice as multipart form data', () => {
    const audioBlob = new Blob(['voice'], { type: 'audio/webm' });
    const context = { buyerName: 'Alice' };

    service.processVoice(audioBlob, context).subscribe();

    const req = httpMock.expectOne(`${environment.apiUrl}/voice`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body instanceof FormData).toBeTrue();

    const body = req.request.body as FormData;
    expect(body.get('audio')).toBeTruthy();
    expect(body.get('context')).toBe(JSON.stringify(context));
    req.flush({});
  });

  it('sends trimmed website context and transcript to /assistant/plan', () => {
    service.planAssistant({ totalAmount: 42 }, '  Step 2 page open  ', 'voice text').subscribe();

    const req = httpMock.expectOne(`${environment.apiUrl}/assistant/plan`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      invoiceContext: { totalAmount: 42 },
      websiteContext: 'Step 2 page open',
      transcript: 'voice text'
    });
    req.flush({ recommendedActions: ['Fill amount'] });
  });
});
