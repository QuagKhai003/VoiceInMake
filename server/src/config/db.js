const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.warn(`⚠️ Primary MongoDB connection failed: ${err.message}. Falling back to in-memory database...`);
    try {
      const mongoServer = await MongoMemoryServer.create();
      const mongoUri = mongoServer.getUri();
      await mongoose.connect(mongoUri);
      console.log('✅ In-Memory MongoDB connected (Fallback)');
    } catch (fallbackErr) {
      console.error(`❌ In-Memory MongoDB failed to start: ${fallbackErr.message}`);
    }
  }
};

module.exports = connectDB;
