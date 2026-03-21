import { of } from 'rxjs';
import { AppComponent } from './app.component';
import { ApiService } from './services/api.service';

describe('AppComponent', () => {
  let component: AppComponent;
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(() => {
    apiService = jasmine.createSpyObj<ApiService>('ApiService', [
      'healthCheck',
      'createInvoice',
      'planAssistant'
    ]);
    apiService.healthCheck.and.returnValue(of({ timestamp: '2026-03-21T00:00:00.000Z' }));
    apiService.createInvoice.and.returnValue(of({}));
    apiService.planAssistant.and.returnValue(of({ recommendedActions: [], assistantResponse: 'Plan ready' }));
    component = new AppComponent(apiService);
  });

  it('sets backend status from health check on init', () => {
    component.ngOnInit();
    expect(component.backendStatus).toContain('Backend OK');
  });

  it('merges extracted entities and sets Needs Info when fields are missing', () => {
    component.masterContext = { buyerName: 'Alice' };
    component.handleAiResponse({
      extractedEntities: { totalAmount: 42 },
      missingFields: ['issueDate'],
      assistantResponse: 'Need the issue date.',
      transcript: 'invoice for forty two'
    });

    expect(component.masterContext).toEqual({ buyerName: 'Alice', totalAmount: 42 });
    expect(component.missingFields).toEqual(['issueDate']);
    expect(component.assistantState).toBe('Needs Info');
    expect(component.assistantMessage).toBe('Plan ready');
    expect(apiService.planAssistant).toHaveBeenCalled();
  });

  it('submits invoice when intent is submit', () => {
    component.masterContext = { buyerName: 'Alice', totalAmount: 42 };

    component.handleAiResponse({
      intent: 'submit',
      extractedEntities: {},
      missingFields: []
    });

    expect(apiService.createInvoice).toHaveBeenCalledWith({ buyerName: 'Alice', totalAmount: 42 });
    expect(component.assistantState).toBe('Idle');
    expect(component.assistantMessage).toContain('Invoice submitted');
  });
});
