const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const rolesRouter = require('./routes/roles');
const { setupDatabase } = require('./database');
const auditRoutes = require('./routes/audit');
const profileRoutes = require('./routes/profile');
const permissionsRouter = require('./routes/permissions');
const resourcesRouter = require('./routes/resources');
const setBrowserInfo = require('./middleware/browserInfo');
const productsRouter = require('./routes/products');
const manufacturersRouter = require('./routes/manufacturers');
const suppliersRouter = require('./routes/suppliers');
const modelsRouter = require('./routes/models');
const warehousesRouter = require('./routes/warehouses');
const stockRouter = require('./routes/stock');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN,
  credentials: true
}));
app.use('/uploads', express.static(process.env.UPLOAD_DIR));
app.use(express.json());
app.use(setBrowserInfo); 

// Routes
app.use('/auth', authRoutes);
app.use('/user', userRoutes);
app.use('/roles', rolesRouter);
app.use('/profile', profileRoutes);
app.use('/audit-logs', auditRoutes);
app.use('/permissions', permissionsRouter);
app.use('/resources', resourcesRouter);
app.use('/products', productsRouter);
app.use('/manufacturers', manufacturersRouter);
app.use('/suppliers', suppliersRouter);
app.use('/models', modelsRouter);
app.use('/warehouses', warehousesRouter);
app.use('/stock', stockRouter);

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    res.json({ status: 'healthy' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// Database setup and server start
setupDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  })
  .catch(err => {
    console.error('Failed to setup database:', err);
    process.exit(1);
  });

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});