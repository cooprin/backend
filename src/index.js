const express = require('express');
const cors = require('cors');

console.log('Starting server initialization...');

// Wrap imports in try-catch to catch any immediate errors
let authRoutes, userRoutes, rolesRouter, auditRoutes, profileRoutes;
let permissionsRouter, resourcesRouter, productsRouter, manufacturersRouter;
let suppliersRouter, modelsRouter, warehousesRouter, stockRouter;
let productTypesRouter, characteristicTypesRouter, clientsRouter;
let wialonRouter, tariffsRouter, servicesRouter, paymentsRoutes;
let companyRouter, wialonIntegrationRouter, invoiceTemplatesRouter;
let wialonSyncRouter, portalRoutes, ticketsRoutes, ticketCommentsRoutes;
let setupDatabase, pool, setBrowserInfo, authenticate, staffOnly;

try {
  console.log('Loading routes and middleware...');
  
  authRoutes = require('./routes/auth');
  console.log('✓ Auth routes loaded');
  
  userRoutes = require('./routes/user');
  console.log('✓ User routes loaded');
  
  rolesRouter = require('./routes/roles');
  console.log('✓ Roles router loaded');
  
  ({ setupDatabase, pool } = require('./database'));
  console.log('✓ Database module loaded');
  
  auditRoutes = require('./routes/audit');
  console.log('✓ Audit routes loaded');
  
  profileRoutes = require('./routes/profile');
  console.log('✓ Profile routes loaded');
  
  permissionsRouter = require('./routes/permissions');
  console.log('✓ Permissions router loaded');
  
  resourcesRouter = require('./routes/resources');
  console.log('✓ Resources router loaded');
  
  setBrowserInfo = require('./middleware/browserInfo');
  console.log('✓ Browser info middleware loaded');
  
  authenticate = require('./middleware/auth');
  console.log('✓ Auth middleware loaded');
  
  ({ staffOnly } = require('./middleware/clientAccess'));
  console.log('✓ Client access middleware loaded');
  
  productsRouter = require('./routes/products');
  console.log('✓ Products router loaded');
  
  manufacturersRouter = require('./routes/manufacturers');
  console.log('✓ Manufacturers router loaded');
  
  suppliersRouter = require('./routes/suppliers');
  console.log('✓ Suppliers router loaded');
  
  modelsRouter = require('./routes/models');
  console.log('✓ Models router loaded');
  
  warehousesRouter = require('./routes/warehouses');
  console.log('✓ Warehouses router loaded');
  
  stockRouter = require('./routes/stock');
  console.log('✓ Stock router loaded');
  
  productTypesRouter = require('./routes/product-types');
  console.log('✓ Product types router loaded');
  
  characteristicTypesRouter = require('./routes/characteristic-types');
  console.log('✓ Characteristic types router loaded');
  
  clientsRouter = require('./routes/clients');
  console.log('✓ Clients router loaded');
  
  wialonRouter = require('./routes/wialon');
  console.log('✓ Wialon router loaded');
  
  tariffsRouter = require('./routes/tariffs');
  console.log('✓ Tariffs router loaded');
  
  servicesRouter = require('./routes/services');
  console.log('✓ Services router loaded');
  
  paymentsRoutes = require('./routes/payments');
  console.log('✓ Payments routes loaded');
  
  companyRouter = require('./routes/company');
  console.log('✓ Company router loaded');
  
  wialonIntegrationRouter = require('./routes/wialon-integration');
  console.log('✓ Wialon integration router loaded');
  
  invoiceTemplatesRouter = require('./routes/invoice-templates');
  console.log('✓ Invoice templates router loaded');
  
  wialonSyncRouter = require('./routes/wialon-sync');
  console.log('✓ Wialon sync router loaded');
  
  portalRoutes = require('./routes/portal');
  console.log('✓ Portal routes loaded');
  
  ticketsRoutes = require('./routes/tickets');
  console.log('✓ Tickets routes loaded');
  
  ticketCommentsRoutes = require('./routes/ticket-comments');
  console.log('✓ Ticket comments routes loaded');
  
  console.log('All modules loaded successfully!');
  
} catch (error) {
  console.error('Error loading modules:', error);
  process.exit(1);
}

const app = express();
app.set('trust proxy', true);
const port = process.env.PORT || 3000;

console.log('Setting up middleware...');

// Middleware
try {
  app.use(cors({
    origin: process.env.CORS_ORIGIN,
    credentials: true
  }));
  console.log('✓ CORS middleware set');
  
  app.use('/uploads', express.static(process.env.UPLOAD_DIR));
  console.log('✓ Static files middleware set');
  
  app.use(express.json());
  console.log('✓ JSON parser middleware set');
  
  app.use(setBrowserInfo);
  console.log('✓ Browser info middleware set');
  
} catch (error) {
  console.error('Error setting up middleware:', error);
  process.exit(1);
}

console.log('Setting up routes...');

// Routes
try {
  app.use('/auth', authRoutes);
  console.log('✓ Auth routes registered');

  // Staff-only routes (existing admin functionality)
  app.use('/user', authenticate, staffOnly, userRoutes);
  app.use('/roles', authenticate, staffOnly, rolesRouter);
  app.use('/profile', authenticate, profileRoutes); // Profile can be used by both
  app.use('/audit-logs', authenticate, staffOnly, auditRoutes);
  app.use('/permissions', authenticate, staffOnly, permissionsRouter);
  app.use('/resources', authenticate, staffOnly, resourcesRouter);
  app.use('/products', authenticate, staffOnly, productsRouter);
  app.use('/manufacturers', authenticate, staffOnly, manufacturersRouter);
  app.use('/suppliers', authenticate, staffOnly, suppliersRouter);
  app.use('/models', authenticate, staffOnly, modelsRouter);
  app.use('/warehouses', authenticate, staffOnly, warehousesRouter);
  app.use('/stock', authenticate, staffOnly, stockRouter);
  app.use('/product-types', authenticate, staffOnly, productTypesRouter);
  app.use('/characteristic-types', authenticate, staffOnly, characteristicTypesRouter);
  app.use('/clients', authenticate, staffOnly, clientsRouter);
  app.use('/wialon', authenticate, staffOnly, wialonRouter);
  app.use('/tariffs', authenticate, staffOnly, tariffsRouter);
  app.use('/services', authenticate, staffOnly, servicesRouter);
  app.use('/billing/payments', authenticate, staffOnly, paymentsRoutes);
  app.use('/company', authenticate, staffOnly, companyRouter);
  app.use('/wialon-integration', authenticate, staffOnly, wialonIntegrationRouter);
  app.use('/wialon-sync', authenticate, staffOnly, wialonSyncRouter);
  app.use('/invoice-templates', authenticate, staffOnly, invoiceTemplatesRouter);
  console.log('✓ Staff-only routes registered');

  // Customer portal routes (clients + staff)
  app.use('/portal', portalRoutes);
  app.use('/tickets', ticketsRoutes);
  app.use('/ticket-comments', ticketCommentsRoutes);
  console.log('✓ Portal routes registered');
  
} catch (error) {
  console.error('Error setting up routes:', error);
  process.exit(1);
}

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    res.json({ status: 'healthy' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

console.log('Health check endpoint registered');

// Add error handling middleware
app.use((error, req, res, next) => {
  console.error('Express error handler caught:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Database setup and server start
console.log('Starting database setup...');
setupDatabase()
  .then(() => {
    console.log('Database setup completed, starting server...');
    
    const server = app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log('Server is ready to accept connections');
    });
    
    // Handle server errors
    server.on('error', (error) => {
      console.error('Server error:', error);
      process.exit(1);
    });
    
    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down gracefully');
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });
    
    process.on('SIGINT', () => {
      console.log('SIGINT received, shutting down gracefully');
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });
    
  })
  .catch(err => {
    console.error('Failed to setup database:', err);
    process.exit(1);
  });

// Enhanced error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise);
  console.error('Reason:', reason);
  // Don't exit immediately, log and continue
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  console.error('Stack:', error.stack);
  process.exit(1);
});

console.log('Error handlers registered, initialization complete');