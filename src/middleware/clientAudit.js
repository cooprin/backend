const AuditService = require('../services/auditService');
const { AUDIT_LOG_TYPES, ENTITY_TYPES, AUDIT_TYPES } = require('../constants/constants');

// Middleware для автоматичного логування дій клієнтів
const logClientAction = (actionType, entityType = null) => {
  return async (req, res, next) => {
    try {
      // Перевіряємо чи це клієнт
      if (req.user?.userType !== 'client') {
        return next();
      }

      // Визначаємо тип сутності автоматично якщо не передано
      const finalEntityType = entityType || determineEntityType(req.path);

      // Логуємо дію
      await AuditService.log({
        clientId: req.user.clientId,
        userType: 'client',
        actionType,
        entityType: finalEntityType,
        entityId: req.params.id || req.body?.id || null,
        newValues: {
          path: req.path,
          method: req.method,
          query: req.query,
          clientId: req.user.clientId,
          wialonUsername: req.user.wialonUsername
        },
        ipAddress: req.ip,
        req,
        auditType: AUDIT_TYPES.BUSINESS
      });

      next();
    } catch (error) {
      console.error('Error in client audit middleware:', error);
      // Не блокуємо запит якщо аудит не вдався
      next();
    }
  };
};

// Middleware для логування після виконання запиту
const logClientResponse = (actionType, entityType = null) => {
  return async (req, res, next) => {
    if (req.user?.userType !== 'client') {
      return next();
    }

    // Перехоплюємо res.json щоб логувати результат
    const originalJson = res.json;
    res.json = function(data) {
      // Логуємо успішну відповідь
      if (data?.success !== false) {
        AuditService.log({
          clientId: req.user.clientId,
          userType: 'client',
          actionType,
          entityType: entityType || determineEntityType(req.path),
          entityId: data?.id || req.params.id || null,
          newValues: {
            path: req.path,
            method: req.method,
            responseData: data,
            clientId: req.user.clientId
          },
          ipAddress: req.ip,
          req,
          auditType: AUDIT_TYPES.BUSINESS
        }).catch(err => console.error('Audit error:', err));
      }
      
      return originalJson.call(this, data);
    };

    next();
  };
};

// Функція для визначення типу сутності по шляху
const determineEntityType = (path) => {
  if (path.includes('/tickets')) return ENTITY_TYPES.TICKET;
  if (path.includes('/chat')) return ENTITY_TYPES.CHAT_MESSAGE;
  if (path.includes('/objects')) return ENTITY_TYPES.WIALON_OBJECT;
  if (path.includes('/invoices')) return ENTITY_TYPES.INVOICE;
  if (path.includes('/profile')) return ENTITY_TYPES.CLIENT;
  return ENTITY_TYPES.CLIENT_SESSION;
};

// Middleware для встановлення контексту клієнта в БД
const setClientContext = async (req, res, next) => {
  try {
    if (req.user?.userType === 'client' && req.user.clientId) {
      // Встановлюємо контекст для тригерів БД
      await req.pool?.query('SELECT set_config($1, $2, true)', ['audit.client_id', req.user.clientId]);
      await req.pool?.query('SELECT set_config($1, $2, true)', ['audit.user_type', 'client']);
      await req.pool?.query('SELECT set_config($1, $2, true)', ['request.client_ip', req.ip]);
    }
    next();
  } catch (error) {
    console.error('Error setting client context:', error);
    next();
  }
};

module.exports = {
  logClientAction,
  logClientResponse,
  setClientContext,
  
  // Готові middleware для основних дій
  viewTickets: logClientAction(AUDIT_LOG_TYPES.CLIENT_PORTAL.VIEW_TICKETS, ENTITY_TYPES.TICKET),
  createTicket: logClientResponse(AUDIT_LOG_TYPES.CLIENT_PORTAL.CREATE_TICKET, ENTITY_TYPES.TICKET),
  updateTicket: logClientResponse(AUDIT_LOG_TYPES.CLIENT_PORTAL.UPDATE_TICKET, ENTITY_TYPES.TICKET),
  addComment: logClientResponse(AUDIT_LOG_TYPES.CLIENT_PORTAL.ADD_COMMENT, ENTITY_TYPES.TICKET_COMMENT),
  viewObjects: logClientAction(AUDIT_LOG_TYPES.CLIENT_PORTAL.VIEW_OBJECTS, ENTITY_TYPES.WIALON_OBJECT),
  viewInvoices: logClientAction(AUDIT_LOG_TYPES.CLIENT_PORTAL.VIEW_INVOICES, ENTITY_TYPES.INVOICE),
  chatMessage: logClientResponse(AUDIT_LOG_TYPES.CLIENT_PORTAL.CHAT_MESSAGE, ENTITY_TYPES.CHAT_MESSAGE),
  profileView: logClientAction(AUDIT_LOG_TYPES.CLIENT_PORTAL.PROFILE_VIEW, ENTITY_TYPES.CLIENT)
};