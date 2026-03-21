const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const REQUIRED_FIELDS = ['buyerName', 'taxId', 'vatNumber', 'buyerAddress', 'invoiceType', 'lineItems'];

const ensureDbReady = (res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({
      message: 'Service Unavailable: Database connection is currently down.',
      error: 'Database disconnected'
    });
    return false;
  }
  return true;
};

const normalizeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeLineItems = (lineItems = []) => {
  if (!Array.isArray(lineItems)) {
    return [];
  }

  return lineItems
    .map((item) => ({
      description: String(item?.description ?? '').trim(),
      quantity: normalizeNumber(item?.quantity),
      unitPrice: normalizeNumber(item?.unitPrice),
      vatRate: normalizeNumber(item?.vatRate),
      lineTotal: normalizeNumber(item?.lineTotal)
    }))
    .filter((item) => item.description);
};

const normalizePayload = (body = {}) => ({
  buyerName: String(body.buyerName ?? '').trim(),
  taxId: String(body.taxId ?? '').trim(),
  vatNumber: String(body.vatNumber ?? '').trim(),
  buyerAddress: String(body.buyerAddress ?? '').trim(),
  invoiceType: String(body.invoiceType ?? '').trim(),
  issueDate: body.issueDate ? new Date(body.issueDate) : new Date(),
  amount: normalizeNumber(body.amount),
  status: body.status ?? 'draft',
  notes: body.notes ?? '',
  source: body.source ?? 'voice',
  lineItems: normalizeLineItems(body.lineItems),
  assistantMetadata: body.assistantMetadata ?? {},
  extractedFields: body.extractedFields ?? {}
});

const computeMissingFields = (payload = {}) => {
  const missing = REQUIRED_FIELDS.filter((field) => {
    if (field === 'lineItems') {
      return !Array.isArray(payload.lineItems) || payload.lineItems.length === 0;
    }
    return !String(payload[field] ?? '').trim();
  });

  if (!(payload.issueDate instanceof Date) || Number.isNaN(payload.issueDate.getTime())) {
    missing.push('issueDate');
  }

  return missing;
};

const formatValidationErrors = (error) => {
  if (error?.errors) {
    return Object.values(error.errors).map((fieldError) => fieldError.message);
  }
  return [error.message];
};

exports.create = async (req, res) => {
  if (!ensureDbReady(res)) {
    return;
  }

  try {
    const payload = normalizePayload(req.body);
    const missingFields = computeMissingFields(payload);

    if (missingFields.length) {
      return res.status(400).json({
        message: 'Invalid invoice payload',
        code: 'INVOICE_VALIDATION_FAILED',
        missingFields
      });
    }

    const invoice = new Invoice(payload);
    await invoice.validate();
    const savedInvoice = await invoice.save();
    res.status(201).json(savedInvoice);
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        message: 'Invalid invoice payload',
        code: 'INVOICE_VALIDATION_FAILED',
        errors: formatValidationErrors(error)
      });
    }
    console.error('Error creating invoice', error);
    res.status(500).json({ message: 'Error creating invoice', error: error.message });
  }
};
