require('dotenv/config');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('./config/db');
const healthRoutes = require('./routes/healthRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/invoice', invoiceRoutes);

// Error handler (must be after routes)
app.use(errorHandler);

// Start server — MongoDB failure must NOT crash the server
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
  });
}).catch(() => {
  // connectDB already logs the warning; start the server anyway
  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
  });
});
