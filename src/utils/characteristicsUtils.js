const { CHARACTERISTIC_TYPES } = require('../constants/constants');

// Функція для валідації значення характеристики
function validateCharacteristicValue(type, value, validationRules = {}, options = []) {
    if (value === undefined || value === null || value === '') {
        return true; // Пусте значення валідне, якщо характеристика не обов'язкова
    }

    switch (type) {
        case CHARACTERISTIC_TYPES.NUMBER:
            if (isNaN(value)) {
                return false;
            }
            const numValue = Number(value);
            if (validationRules.min !== undefined && numValue < validationRules.min) {
                return false;
            }
            if (validationRules.max !== undefined && numValue > validationRules.max) {
                return false;
            }
            return true;

        case CHARACTERISTIC_TYPES.DATE:
            const date = new Date(value);
            return !isNaN(date.getTime());

        case CHARACTERISTIC_TYPES.BOOLEAN:
            return typeof value === 'boolean' || ['true', 'false'].includes(value.toLowerCase());

        case CHARACTERISTIC_TYPES.SELECT:
            return options.includes(value);

        case CHARACTERISTIC_TYPES.STRING:
            if (validationRules.pattern) {
                const regex = new RegExp(validationRules.pattern);
                return regex.test(value);
            }
            if (validationRules.minLength && value.length < validationRules.minLength) {
                return false;
            }
            if (validationRules.maxLength && value.length > validationRules.maxLength) {
                return false;
            }
            return true;

        default:
            return false;
    }
}

// Функція для форматування значення характеристики
function formatCharacteristicValue(type, value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    switch (type) {
        case CHARACTERISTIC_TYPES.NUMBER:
            return Number(value);

        case CHARACTERISTIC_TYPES.DATE:
            return new Date(value).toISOString();

        case CHARACTERISTIC_TYPES.BOOLEAN:
            if (typeof value === 'boolean') return value;
            return value.toLowerCase() === 'true';

        case CHARACTERISTIC_TYPES.SELECT:
        case CHARACTERISTIC_TYPES.STRING:
            return String(value);

        default:
            return value;
    }
}

// Функція для отримання значення за замовчуванням
function getDefaultValue(type, defaultValue) {
    if (defaultValue !== undefined && defaultValue !== null) {
        return formatCharacteristicValue(type, defaultValue);
    }

    switch (type) {
        case CHARACTERISTIC_TYPES.NUMBER:
            return 0;
        case CHARACTERISTIC_TYPES.BOOLEAN:
            return false;
        case CHARACTERISTIC_TYPES.DATE:
            return null;
        case CHARACTERISTIC_TYPES.SELECT:
        case CHARACTERISTIC_TYPES.STRING:
            return '';
        default:
            return null;
    }
}

// Функція для валідації характеристик продукту
async function validateProductCharacteristics(client, productTypeId, characteristics) {
    // Отримуємо всі характеристики для даного типу продукту
    const typeCharacteristics = await client.query(
        `SELECT * FROM products.product_type_characteristics 
         WHERE product_type_id = $1
         ORDER BY ordering`,
        [productTypeId]
    );

    const errors = [];

    // Перевіряємо кожну характеристику
    for (const tc of typeCharacteristics.rows) {
        const value = characteristics[tc.code];

        // Перевіряємо обов'язкові поля
        if (tc.is_required && (value === undefined || value === null || value === '')) {
            errors.push(`Characteristic ${tc.name} (${tc.code}) is required`);
            continue;
        }

        // Якщо значення не надано, пропускаємо подальшу валідацію
        if (value === undefined || value === null || value === '') {
            continue;
        }

        // Валідуємо значення
        const isValid = validateCharacteristicValue(
            tc.type,
            value,
            tc.validation_rules,
            tc.options
        );

        if (!isValid) {
            errors.push(`Invalid value for characteristic ${tc.name} (${tc.code})`);
        }
    }

    return {
        isValid: errors.length === 0,
        errors
    };
}

module.exports = {
    validateCharacteristicValue,
    formatCharacteristicValue,
    getDefaultValue,
    validateProductCharacteristics
};