require('dotenv').config();
const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const { setupDatabase } = require('./database');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN,
  credentials: true
}));
app.use(express.json());
//for test
// Routes
app.use('/auth', authRoutes);

// Database setup
setupDatabase().then(() => {
  // Start server
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}).catch(err => {
  console.error('Failed to setup database:', err);
  process.exit(1);
});