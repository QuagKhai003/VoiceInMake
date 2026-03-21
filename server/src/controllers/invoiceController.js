const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');

exports.create = async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ 
      message: 'Service Unavailable: Database connection is currently down.',
      error: 'Database disconnected'
    });
  }

  try {
    const newInvoice = new Invoice(req.body);
    const savedInvoice = await newInvoice.save();
    res.status(201).json(savedInvoice);
  } catch (error) {
    res.status(500).json({ message: 'Error creating invoice', error: error.message });
  }
};
