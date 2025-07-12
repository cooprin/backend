const { pool } = require('../database');
const AuditService = require('./auditService');
const { AUDIT_TYPES } = require('../constants/constants');
const {
  SUPPORTED_CURRENCIES,
  CURRENCY_FORMATS,
  DEFAULT_CURRENCY_SETTINGS,
  CURRENCY_SETTING_KEYS,
  CURRENCY_SETTINGS_CATEGORY
} = require('../constants/currencies');

class CurrencyService {
  // Отримання поточних налаштувань валюти
  static async getCurrencySettings() {
    try {
      const query = `
        SELECT key, value, description 
        FROM company.system_settings 
        WHERE category = $1
        ORDER BY key
      `;
      
      const result = await pool.query(query, [CURRENCY_SETTINGS_CATEGORY]);
      
      // Перетворюємо масив в об'єкт для зручності
      const settings = result.rows.reduce((acc, row) => {
        acc[row.key] = row.value;
        return acc;
      }, {});
      
      // Якщо налаштувань немає, повертаємо дефолтні
      if (Object.keys(settings).length === 0) {
        return DEFAULT_CURRENCY_SETTINGS;
      }
      
      return {
        currency: settings[CURRENCY_SETTING_KEYS.DEFAULT_CURRENCY] || DEFAULT_CURRENCY_SETTINGS.currency,
        format: settings[CURRENCY_SETTING_KEYS.CURRENCY_FORMAT] || DEFAULT_CURRENCY_SETTINGS.format,
        decimalPlaces: settings[CURRENCY_SETTING_KEYS.DECIMAL_PLACES] !== undefined ? parseInt(settings[CURRENCY_SETTING_KEYS.DECIMAL_PLACES]) : DEFAULT_CURRENCY_SETTINGS.decimalPlaces,
        useThousandsSeparator: settings[CURRENCY_SETTING_KEYS.USE_THOUSANDS_SEPARATOR] !== 'false'
      };
    } catch (error) {
      console.error('Error fetching currency settings:', error);
      return DEFAULT_CURRENCY_SETTINGS;
    }
  }

  // Збереження налаштувань валюти
  static async saveCurrencySettings(client, settings, userId, req) {
    try {
      const settingsToSave = [
        {
          key: CURRENCY_SETTING_KEYS.DEFAULT_CURRENCY,
          value: settings.currency || DEFAULT_CURRENCY_SETTINGS.currency,
          description: 'Default system currency code'
        },
        {
          key: CURRENCY_SETTING_KEYS.CURRENCY_FORMAT,
          value: settings.format || DEFAULT_CURRENCY_SETTINGS.format,
          description: 'Currency display format'
        },
        {
          key: CURRENCY_SETTING_KEYS.DECIMAL_PLACES,
          value: (settings.decimalPlaces !== undefined ? settings.decimalPlaces : DEFAULT_CURRENCY_SETTINGS.decimalPlaces).toString(),
          description: 'Number of decimal places for currency display'
        },
        {
          key: CURRENCY_SETTING_KEYS.USE_THOUSANDS_SEPARATOR,
          value: (settings.useThousandsSeparator !== undefined ? settings.useThousandsSeparator : DEFAULT_CURRENCY_SETTINGS.useThousandsSeparator).toString(),
          description: 'Use thousands separator in currency display'
        }
      ];

      for (const setting of settingsToSave) {
        // Перевіряємо чи існує налаштування
        const existingQuery = `
          SELECT id FROM company.system_settings 
          WHERE category = $1 AND key = $2
        `;
        const existingResult = await client.query(existingQuery, [CURRENCY_SETTINGS_CATEGORY, setting.key]);

        if (existingResult.rows.length > 0) {
          // Оновлюємо існуюче
          await client.query(
            `UPDATE company.system_settings 
             SET value = $1, description = $2, updated_at = $3
             WHERE category = $4 AND key = $5`,
            [setting.value, setting.description, new Date(), CURRENCY_SETTINGS_CATEGORY, setting.key]
          );
        } else {
          // Створюємо нове
          await client.query(
            `INSERT INTO company.system_settings (category, key, value, description, created_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [CURRENCY_SETTINGS_CATEGORY, setting.key, setting.value, setting.description, userId]
          );
        }
      }

      // Аудит
      await AuditService.log({
        userId,
        actionType: 'CURRENCY_SETTINGS_UPDATE',
        entityType: 'SYSTEM_SETTINGS',
        entityId: CURRENCY_SETTINGS_CATEGORY,
        newValues: settings,
        ipAddress: req.ip,
        tableSchema: 'company',
        tableName: 'system_settings',
        auditType: AUDIT_TYPES.SYSTEM,
        req
      });

      return await this.getCurrencySettings();
    } catch (error) {
      throw error;
    }
  }

  // Отримання списку підтримуваних валют
  static getSupportedCurrencies() {
    return SUPPORTED_CURRENCIES;
  }

  // Отримання форматів відображення
  static getCurrencyFormats() {
    return Object.values(CURRENCY_FORMATS);
  }

  // Форматування суми згідно поточних налаштувань
  static async formatAmount(amount, currencySettings = null) {
    if (!currencySettings) {
      currencySettings = await this.getCurrencySettings();
    }

    const currency = SUPPORTED_CURRENCIES.find(c => c.code === currencySettings.currency);
    if (!currency) {
      return amount.toString();
    }

    // Форматуємо число
    const parts = Number(amount).toFixed(currencySettings.decimalPlaces).split('.');
    
    if (currencySettings.useThousandsSeparator) {
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    }
    
    const formattedAmount = parts.join('.');
    
    // Застосовуємо формат
    switch (currencySettings.format) {
      case CURRENCY_FORMATS.SYMBOL_BEFORE:
        return `${currency.symbol}${formattedAmount}`;
      case CURRENCY_FORMATS.SYMBOL_AFTER:
        return `${formattedAmount} ${currency.symbol}`;
      case CURRENCY_FORMATS.CODE_AFTER:
        return `${formattedAmount} ${currency.code}`;
      default:
        return `${currency.symbol}${formattedAmount}`;
    }
  }

  // Отримання інформації про валюту за кодом
  static getCurrencyByCode(code) {
    return SUPPORTED_CURRENCIES.find(c => c.code === code);
  }
}

module.exports = CurrencyService;