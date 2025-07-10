const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const rolesRouter = require('./routes/roles');
const { setupDatabase, pool } = require('./database');
const auditRoutes = require('./routes/audit');
const profileRoutes = require('./routes/profile');
const permissionsRouter = require('./routes/permissions');
const resourcesRouter = require('./routes/resources');
const setBrowserInfo = require('./middleware/browserInfo');
const authenticate = require('./middleware/auth');
const { staffOnly } = require('./middleware/clientAccess');
const productsRouter = require('./routes/products');
const manufacturersRouter = require('./routes/manufacturers');
const suppliersRouter = require('./routes/suppliers');
const modelsRouter = require('./routes/models');
const warehousesRouter = require('./routes/warehouses');
const stockRouter = require('./routes/stock');
const productTypesRouter = require('./routes/product-types');
const characteristicTypesRouter = require('./routes/characteristic-types');
const clientsRouter = require('./routes/clients');
const wialonRouter = require('./routes/wialon');
const tariffsRouter = require('./routes/tariffs');
const servicesRouter = require('./routes/services');
const paymentsRoutes = require('./routes/payments');
const companyRouter = require('./routes/company');
const wialonIntegrationRouter = require('./routes/wialon-integration');
const wialonSyncRouter = require('./routes/wialon-sync');
const portalRoutes = require('./routes/portal');
const ticketsRoutes = require('./routes/tickets');
const ticketCommentsRoutes = require('./routes/ticket-comments');
const notificationsRoutes = require('./routes/notifications');
const chatRoutes = require('./routes/chat');
const reportsRouter = require('./routes/reports');
const licenseRoutes = require('./routes/license');
const systemRouter = require('./routes/system');
const emailRouter = require('./routes/email');
const emailTemplatesRouter = require('./routes/email-templates');

const app = express();
app.set('trust proxy', true);
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
app.use('/license', authenticate, licenseRoutes);
app.use('/system', authenticate, systemRouter);
app.use('/email', authenticate, emailRouter);
app.use('/email-templates', authenticate, staffOnly, emailTemplatesRouter);

// Customer portal routes (clients + staff)
app.use('/portal', portalRoutes);
app.use('/tickets', ticketsRoutes);
app.use('/ticket-comments', ticketCommentsRoutes);
app.use('/notifications', authenticate, notificationsRoutes);
app.use('/chat', authenticate, chatRoutes);
app.use('/reports', authenticate, reportsRouter);

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
    const server = require('http').createServer(app);
    const io = require('socket.io')(server, {
      cors: {
        origin: process.env.CORS_ORIGIN,
        credentials: true
      }
    });

    // Підключаємо Socket.io логіку
    require('./socket/socketHandler')(io);

    // Підключаємо PostgreSQL notification слухач
    const { setupNotificationListener } = require('./socket/notificationListener');
    const objectsRealtimeService = require('./socket/objectsRealtimeService');
    setupNotificationListener();
    objectsRealtimeService.start();

    server.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log(`WebSocket server ready`);
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
// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  objectsRealtimeService.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Shutting down gracefully...');
  objectsRealtimeService.stop();
  process.exit(0);
});