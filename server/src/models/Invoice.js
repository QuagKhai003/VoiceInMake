const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  // Fields will be defined in a future task
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Invoice', invoiceSchema);
