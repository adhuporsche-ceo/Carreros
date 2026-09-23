const mongoose = require('mongoose');

let mongod = null;

const connectDB = async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/student_profiling_system';
  
  try {
    // Attempt standard connection with a short timeout
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 3000,
    });
    console.log(`MongoDB Connected Successfully: ${conn.connection.host}`);
    return conn;
  } catch (err) {
    console.warn(`\n[Database Notice] Could not connect to primary MongoDB URI (${uri}): ${err.message}`);
    console.log('[Database Notice] Launching embedded in-memory MongoDB for zero-configuration academic demonstration...');
    
    try {
      const { MongoMemoryServer } = require('mongodb-memory-server');
      console.log('[Database Notice] Initializing embedded MongoDB binary (first time may take a moment to download binary)...');
      mongod = await MongoMemoryServer.create({
        spawnTimeoutMS: 120000,
      });
      const memoryUri = mongod.getUri();
      
      const conn = await mongoose.connect(memoryUri);
      console.log(`MongoDB Connected Successfully (In-Memory Demo Instance): ${memoryUri}`);
      return conn;
    } catch (memErr) {
      console.error('Fatal Database Connection Error:', memErr.message);
      process.exit(1);
    }
  }
};

const closeDB = async () => {
  try {
    await mongoose.connection.close();
    if (mongod) {
      await mongod.stop();
    }
    console.log('MongoDB connection closed.');
  } catch (err) {
    console.error('Error closing MongoDB connection:', err.message);
  }
};

module.exports = { connectDB, closeDB };
