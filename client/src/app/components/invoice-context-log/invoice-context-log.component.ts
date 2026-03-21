import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule, KeyValuePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-invoice-context-log',
  standalone: true,
  imports: [CommonModule, FormsModule, KeyValuePipe],
  templateUrl: './invoice-context-log.component.html',
  styleUrl: './invoice-context-log.component.scss'
})
export class InvoiceContextLogComponent {
  @Input() context: { [key: string]: any } = {};
  @Output() contextChange = new EventEmitter<{ [key: string]: any }>();
  @Output() submitInvoice = new EventEmitter<void>();

  editingKey: string | null = null;
  editValue: string = '';

  objectKeys(obj: any): string[] {
    return Object.keys(obj || {});
  }

  startEdit(key: string, value: any) {
    this.editingKey = key;
    this.editValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  saveEdit(key: string) {
    try {
      // Try to parse as JSON if it was an object, otherwise keep as string/number
      const parsedValue = this.isJsonString(this.editValue) 
        ? JSON.parse(this.editValue) 
        : this.inferType(this.editValue);
      
      this.context[key] = parsedValue;
    } catch (e) {
      this.context[key] = this.editValue;
    }
    
    this.editingKey = null;
    this.contextChange.emit(this.context);
  }

  cancelEdit() {
    this.editingKey = null;
  }

  onSubmit() {
    this.submitInvoice.emit();
  }

  private isJsonString(str: string) {
    try {
      JSON.parse(str);
    } catch (e) {
      return false;
    }
    return true;
  }

  private inferType(value: string): any {
    if (!isNaN(Number(value)) && value.trim() !== '') {
      return Number(value);
    }
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    return value;
  }
}
