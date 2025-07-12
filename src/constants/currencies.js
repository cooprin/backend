// Валюти що підтримуються системою
const SUPPORTED_CURRENCIES = [
  {
    code: 'UAH',
    name: 'Ukrainian Hryvnia',
    symbol: '₴',
    namePlural: 'Ukrainian Hryvnias'
  },
  {
    code: 'USD',
    name: 'US Dollar',
    symbol: '$',
    namePlural: 'US Dollars'
  },
  {
    code: 'EUR',
    name: 'Euro',
    symbol: '€',
    namePlural: 'Euros'
  },
  {
    code: 'GBP',
    name: 'British Pound',
    symbol: '£',
    namePlural: 'British Pounds'
  },
  {
    code: 'PLN',
    name: 'Polish Zloty',
    symbol: 'zł',
    namePlural: 'Polish Zloty'
  },
  {
    code: 'CZK',
    name: 'Czech Koruna',
    symbol: 'Kč',
    namePlural: 'Czech Korunas'
  }
];

// Формати відображення валюти
const CURRENCY_FORMATS = {
  SYMBOL_BEFORE: 'symbol_before',    // $100
  SYMBOL_AFTER: 'symbol_after',     // 100 $
  CODE_AFTER: 'code_after'          // 100 USD
};

// Налаштування валюти за замовчуванням
const DEFAULT_CURRENCY_SETTINGS = {
  currency: 'UAH',
  format: CURRENCY_FORMATS.SYMBOL_BEFORE,
  decimalPlaces: 2,
  useThousandsSeparator: true
};

// Ключі для system_settings
const CURRENCY_SETTING_KEYS = {
  DEFAULT_CURRENCY: 'default_currency',
  CURRENCY_FORMAT: 'currency_format',
  DECIMAL_PLACES: 'decimal_places',
  USE_THOUSANDS_SEPARATOR: 'use_thousands_separator'
};

const CURRENCY_SETTINGS_CATEGORY = 'currency';

module.exports = {
  SUPPORTED_CURRENCIES,
  CURRENCY_FORMATS,
  DEFAULT_CURRENCY_SETTINGS,
  CURRENCY_SETTING_KEYS,
  CURRENCY_SETTINGS_CATEGORY
};