const ENTITY_TYPES = {
    USER: 'USER',
    ROLE: 'ROLE',
    PERMISSION: 'PERMISSION',
    PERMISSION_GROUP: 'PERMISSION_GROUP',
    RESOURCE: 'RESOURCE',
    RESOURCE_ACTION: 'RESOURCE_ACTION',
    AUDIT_LOG: 'AUDIT_LOG',
    MANUFACTURER: 'MANUFACTURER',
    SUPPLIER: 'SUPPLIER',
    MODEL: 'MODEL',
    PRODUCT: 'PRODUCT',
    PRODUCT_TYPE: 'PRODUCT_TYPE',
    PRODUCT_CHARACTERISTIC: 'PRODUCT_CHARACTERISTIC',
    WAREHOUSE: 'WAREHOUSE',
    STOCK: 'STOCK'
};

const AUDIT_TYPES = {
    SYSTEM: 'SYSTEM',
    BUSINESS: 'BUSINESS'
};

const AUDIT_LOG_TYPES = {
    SYSTEM: {
        ERROR: 'ERROR'
    },
    AUTH: {
        LOGIN: 'LOGIN',
        LOGOUT: 'LOGOUT',
        LOGIN_FAILED: 'LOGIN_FAILED',
        LOGIN_SUCCESS: 'LOGIN_SUCCESS'
    },
    USER: {
        CREATE: 'USER_CREATE',
        UPDATE: 'USER_UPDATE',
        DELETE: 'USER_DELETE',
        DELETE_WITH_AUDIT: 'USER_DELETE_WITH_AUDIT',
        STATUS_CHANGE: 'USER_STATUS_CHANGE',
        PASSWORD_CHANGE: 'USER_PASSWORD_CHANGE',
        PASSWORD_CHANGE_FAILED: 'USER_PASSWORD_CHANGE_FAILED',
        ACTIVATE: 'USER_ACTIVATE',
        DEACTIVATE: 'USER_DEACTIVATE',
        PROFILE_UPDATE: 'USER_PROFILE_UPDATE',
        AVATAR_UPDATE: 'USER_AVATAR_UPDATE'
    },
    ROLE: {
        CREATE: 'ROLE_CREATE',
        UPDATE: 'ROLE_UPDATE',
        DELETE: 'ROLE_DELETE',
        DELETE_ATTEMPT: 'ROLE_DELETE_ATTEMPT'
    },
    PERMISSION: {
        CREATE: 'PERMISSION_CREATE',
        UPDATE: 'PERMISSION_UPDATE',
        DELETE: 'PERMISSION_DELETE',
        GROUP_CREATE: 'PERMISSION_GROUP_CREATE',
        GROUP_UPDATE: 'PERMISSION_GROUP_UPDATE'
    },
    RESOURCE: {
        CREATE: 'RESOURCE_CREATE',
        UPDATE: 'RESOURCE_UPDATE',
        DELETE: 'RESOURCE_DELETE',
        ACTIONS_UPDATE: 'RESOURCE_ACTIONS_UPDATE'
    },
    AUDIT: {
        EXPORT: 'AUDIT_EXPORT',
        EXPORT_SUCCESS: 'AUDIT_EXPORT_SUCCESS',
        EXPORT_ERROR: 'AUDIT_EXPORT_ERROR'
    },
    PRODUCT: {
        CREATE: 'PRODUCT_CREATE',
        UPDATE: 'PRODUCT_UPDATE',
        DELETE: 'PRODUCT_DELETE',
        STATUS_CHANGE: 'PRODUCT_STATUS_CHANGE',
        MANUFACTURER_CREATE: 'MANUFACTURER_CREATE',
        MANUFACTURER_UPDATE: 'MANUFACTURER_UPDATE',
        MANUFACTURER_DELETE: 'MANUFACTURER_DELETE',
        SUPPLIER_CREATE: 'SUPPLIER_CREATE',
        SUPPLIER_UPDATE: 'SUPPLIER_UPDATE',
        SUPPLIER_DELETE: 'SUPPLIER_DELETE',
        MODEL_CREATE: 'MODEL_CREATE',
        MODEL_UPDATE: 'MODEL_UPDATE',
        MODEL_DELETE: 'MODEL_DELETE'
    },
    PRODUCT_TYPE: {
        CREATE: 'PRODUCT_TYPE_CREATE',
        UPDATE: 'PRODUCT_TYPE_UPDATE',
        DELETE: 'PRODUCT_TYPE_DELETE',
        CHARACTERISTIC_CREATE: 'PRODUCT_TYPE_CHARACTERISTIC_CREATE',
        CHARACTERISTIC_UPDATE: 'PRODUCT_TYPE_CHARACTERISTIC_UPDATE',
        CHARACTERISTIC_DELETE: 'PRODUCT_TYPE_CHARACTERISTIC_DELETE',
        CHARACTERISTIC_ORDER_UPDATE: 'PRODUCT_TYPE_CHARACTERISTIC_ORDER_UPDATE'
    },
    WAREHOUSE: {
        CREATE: 'WAREHOUSE_CREATE',
        UPDATE: 'WAREHOUSE_UPDATE',
        DELETE: 'WAREHOUSE_DELETE'
    },
    STOCK: {
        TRANSFER: 'STOCK_TRANSFER',
        INCREASE: 'STOCK_INCREASE',
        DECREASE: 'STOCK_DECREASE',
        INSTALL: 'STOCK_INSTALL',
        UNINSTALL: 'STOCK_UNINSTALL',
        REPAIR_SEND: 'STOCK_REPAIR_SEND',
        REPAIR_RETURN: 'STOCK_REPAIR_RETURN',
        WRITE_OFF: 'STOCK_WRITE_OFF',
        WARRANTY_CHANGE: 'STOCK_WARRANTY_CHANGE'
    }
};

const PRODUCT_STATUS = {
    IN_STOCK: 'in_stock',
    INSTALLED: 'installed',
    IN_REPAIR: 'in_repair',
    WRITTEN_OFF: 'written_off'
};

const STOCK_MOVEMENT_TYPES = {
    TRANSFER: 'transfer',
    INSTALL: 'install',
    UNINSTALL: 'uninstall',
    REPAIR_SEND: 'repair_send',
    REPAIR_RETURN: 'repair_return',
    WRITE_OFF: 'write_off',
    WARRANTY_CHANGE: 'warranty_change',
    STOCK_IN: 'stock_in',
    STOCK_OUT: 'stock_out'
};

const CHARACTERISTIC_TYPES = {
    STRING: 'string',
    NUMBER: 'number',
    DATE: 'date',
    BOOLEAN: 'boolean',
    SELECT: 'select'
};

module.exports = {
    ENTITY_TYPES,
    AUDIT_TYPES,
    AUDIT_LOG_TYPES,
    PRODUCT_STATUS,
    STOCK_MOVEMENT_TYPES,
    CHARACTERISTIC_TYPES
};