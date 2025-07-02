# Reports Configuration

Ця папка містить конфігураційні файли звітів, які автоматично завантажуються в базу даних.

## Структура папок

```
reports/
├── clients/          # Звіти для сторінки клієнтів
├── billing/          # Звіти для платіжної системи
├── wialon/           # Звіти для об'єктів Wialon
├── products/         # Звіти для товарів
├── warehouses/       # Звіти для складів
├── services/         # Звіти для послуг
└── dashboard/        # Звіти для головної сторінки
```

## Формат файлів звітів

Кожен звіт описується в JSON файлі з наступною структурою:

```json
{
  "name": "Назва звіту",
  "code": "unique_report_code",
  "description": "Опис звіту",
  "sql_query": "SELECT * FROM table WHERE condition = :parameter",
  "output_format": "table|chart|export|both",
  "execution_timeout": 30,
  "cache_duration": 60,
  "chart_config": {
    "type": "bar|line|pie",
    "x_axis": "column_name",
    "y_axis": "column_name"
  },
  "parameters": [
    {
      "parameter_name": "parameter",
      "parameter_type": "text|number|date|select|boolean|client_id|user_id",
      "display_name": "Відображувана назва",
      "description": "Опис параметра",
      "is_required": true,
      "default_value": "значення",
      "validation_rules": {},
      "options": [],
      "ordering": 1
    }
  ],
  "page_assignments": [
    {
      "page_identifier": "clients",
      "page_title": "Клієнти",
      "display_order": 1,
      "is_visible": true,
      "auto_execute": false
    }
  ]
}
```

## Параметри звітів

### Типи параметрів:
- **text** - текстове поле
- **number** - числове поле
- **date** - дата
- **datetime** - дата та час
- **select** - випадаючий список
- **multiselect** - множинний вибір
- **boolean** - так/ні
- **client_id** - автозаповнення клієнтів
- **user_id** - автозаповнення користувачів

### Використання параметрів в SQL:
Параметри в SQL запитах використовуються з префіксом `:`:
```sql
SELECT * FROM clients.clients 
WHERE name ILIKE '%:search%' 
AND created_at >= :start_date
```

## Формати виводу

- **table** - табличний вигляд
- **chart** - графічний вигляд
- **export** - тільки для експорту
- **both** - таблиця + графік

## Ідентифікатори сторінок

Доступні ідентифікатори для прив'язки звітів:
- `clients` - сторінка клієнтів
- `wialon_objects` - сторінка об'єктів Wialon
- `billing` - платіжна система
- `products` - товари
- `warehouses` - склади
- `services` - послуги
- `dashboard` - головна сторінка
- `users` - користувачі
- `audit` - аудит

## Приклад звіту

Дивіться файл `clients/client-list.json` як приклад базового звіту.