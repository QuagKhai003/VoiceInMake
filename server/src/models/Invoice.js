const mongoose = require('mongoose');

const lineItemSchema = new mongoose.Schema({
  description: { type: String, trim: true, default: '' },
  quantity: { type: Number, min: 0, default: 0 },
  unitPrice: { type: Number, min: 0, default: 0 },
  vatRate: { type: Number, min: 0, max: 1, default: 0 },
  lineTotal: { type: Number, min: 0, default: 0 }
}, { _id: false });

const assistantMetadataSchema = new mongoose.Schema({
  missingFields: { type: [String], default: [] },
  confidence: { type: Number, min: 0, max: 1, default: 0 },
  intent: {
    type: String,
    enum: ['collect_more', 'confirm', 'submit'],
    default: 'collect_more'
  },
  lastQuestion: { type: String, trim: true, default: '' }
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  buyerName: { type: String, trim: true, default: '' },
  taxId: { type: String, trim: true, default: '' },
  vatNumber: { type: String, trim: true, default: '' },
  buyerAddress: { type: String, trim: true, default: '' },
  invoiceType: { type: String, trim: true, default: 'digital' },
  issueDate: { type: Date, default: Date.now },
  amount: { type: Number, min: 0, default: 0 },
  status: {
    type: String,
    enum: ['draft', 'pending', 'submitted', 'error'],
    default: 'draft'
  },
  notes: { type: String, default: '' },
  source: { type: String, default: 'voice' },
  lineItems: { type: [lineItemSchema], default: [] },
  assistantMetadata: { type: assistantMetadataSchema, default: () => ({}) },
  extractedFields: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

module.exports = mongoose.model('Invoice', invoiceSchema);
