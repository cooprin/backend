const { pool } = require('../database');
const AuditService = require('./auditService');
const { ENTITY_TYPES, AUDIT_TYPES } = require('../constants/constants');

class InvoiceTemplatesService {
    // Отримання списку шаблонів
    static async getTemplates(filters = {}) {
        try {
            const {
                page = 1,
                perPage = 10,
                sortBy = 'name',
                descending = false,
                search = '',
                is_active = null,
                is_default = null
            } = filters;

            let conditions = [];
            let params = [];
            let paramIndex = 1;

            if (search) {
                conditions.push(`(
                    name ILIKE $${paramIndex} OR
                    code ILIKE $${paramIndex} OR
                    description ILIKE $${paramIndex}
                )`);
                params.push(`%${search}%`);
                paramIndex++;
            }

            if (is_active !== null) {
                conditions.push(`is_active = $${paramIndex}`);
                params.push(is_active === 'true' || is_active === true);
                paramIndex++;
            }

            if (is_default !== null) {
                conditions.push(`is_default = $${paramIndex}`);
                params.push(is_default === 'true' || is_default === true);
                paramIndex++;
            }

            const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
            const orderDirection = descending === 'true' || descending === true ? 'DESC' : 'ASC';
            
            // Визначення поля для сортування
            let orderByField;
            switch(sortBy) {
                case 'name':
                    orderByField = 'name';
                    break;
                case 'code':
                    orderByField = 'code';
                    break;
                case 'is_default':
                    orderByField = 'is_default';
                    break;
                case 'is_active':
                    orderByField = 'is_active';
                    break;
                case 'created_at':
                    orderByField = 'created_at';
                    break;
                default:
                    orderByField = 'name';
            }

            // Обробка опції "всі записи" для експорту
            const limit = perPage === 'All' ? null : parseInt(perPage);
            const offset = limit ? (parseInt(page) - 1) * limit : 0;
            
            let query = `
                SELECT 
                    t.*,
                    u.email as created_by_email,
                    u.first_name || ' ' || u.last_name as created_by_name,
                    COUNT(i.id) as usage_count
                FROM billing.invoice_templates t
                LEFT JOIN auth.users u ON t.created_by = u.id
                LEFT JOIN services.invoices i ON i.template_id = t.id
                ${whereClause}
                GROUP BY t.id, u.email, u.first_name, u.last_name
                ORDER BY ${orderByField} ${orderDirection}
            `;

            if (limit !== null) {
                query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
                params.push(limit, offset);
            }

            const countQuery = `
                SELECT COUNT(*) FROM billing.invoice_templates
                ${whereClause}
            `;

            const [templatesResult, countResult] = await Promise.all([
                pool.query(query, params),
                pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : [])
            ]);

            return {
                templates: templatesResult.rows,
                total: parseInt(countResult.rows[0].count)
            };
        } catch (error) {
            console.error('Error fetching invoice templates:', error);
            throw error;
        }
    }

    // Отримання шаблону за ID
    static async getTemplateById(id) {
        try {
            const query = `
                SELECT 
                    t.*,
                    u.email as created_by_email,
                    u.first_name || ' ' || u.last_name as created_by_name
                FROM billing.invoice_templates t
                LEFT JOIN auth.users u ON t.created_by = u.id
                WHERE t.id = $1
            `;
            
            const result = await pool.query(query, [id]);
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            console.error('Error fetching invoice template:', error);
            throw error;
        }
    }

    // Створення нового шаблону
    static async createTemplate(client, data, userId, req) {
        try {
            // Перевірка обов'язкових полів
            const requiredFields = ['name', 'code', 'html_template'];
            
            for (const field of requiredFields) {
                if (!data[field]) {
                    throw new Error(`Поле ${field} є обов'язковим`);
                }
            }
            
            // Перевірка унікальності коду
            const existingCheck = await client.query(
                'SELECT id FROM billing.invoice_templates WHERE code = $1',
                [data.code]
            );
            
            if (existingCheck.rows.length > 0) {
                throw new Error(`Шаблон з кодом "${data.code}" вже існує`);
            }
            
            // Якщо це шаблон за замовчуванням, скидаємо прапорець у інших шаблонів
            if (data.is_default) {
                await client.query(
                    'UPDATE billing.invoice_templates SET is_default = false'
                );
            }
            
            // Створення шаблону
            const query = `
                INSERT INTO billing.invoice_templates (
                    name, code, html_template, css_styles, 
                    description, is_default, is_active, 
                    metadata, created_by
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9
                )
                RETURNING *
            `;
            
            const result = await client.query(query, [
                data.name,
                data.code,
                data.html_template,
                data.css_styles || null,
                data.description || null,
                data.is_default === true,
                data.is_active !== undefined ? data.is_active : true,
                data.metadata ? JSON.stringify(data.metadata) : null,
                userId
            ]);
            
            // Аудит
            await AuditService.log({
                userId,
                actionType: 'INVOICE_TEMPLATE_CREATE',
                entityType: 'INVOICE_TEMPLATE',
                entityId: result.rows[0].id,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'billing',
                tableName: 'invoice_templates',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return result.rows[0];
        } catch (error) {
            console.error('Error creating invoice template:', error);
            throw error;
        }
    }

    // Оновлення шаблону
    static async updateTemplate(client, id, data, userId, req) {
        try {
            // Перевірка існування шаблону
            const templateCheck = await client.query(
                'SELECT * FROM billing.invoice_templates WHERE id = $1',
                [id]
            );
            
            if (templateCheck.rows.length === 0) {
                throw new Error('Шаблон не знайдено');
            }
            
            const oldData = templateCheck.rows[0];
            
            // Перевірка унікальності коду
            if (data.code && data.code !== oldData.code) {
                const codeCheck = await client.query(
                    'SELECT id FROM billing.invoice_templates WHERE code = $1 AND id != $2',
                    [data.code, id]
                );
                
                if (codeCheck.rows.length > 0) {
                    throw new Error(`Шаблон з кодом "${data.code}" вже існує`);
                }
            }
            
            // Якщо це шаблон за замовчуванням, скидаємо прапорець у інших шаблонів
            if (data.is_default === true) {
                await client.query(
                    'UPDATE billing.invoice_templates SET is_default = false WHERE id != $1',
                    [id]
                );
            }
            
            // Підготовка полів для оновлення
            const fields = [];
            const values = [];
            let paramIndex = 1;
            
            // Доступні поля для оновлення
            const updateableFields = [
                'name', 'code', 'html_template', 'css_styles', 
                'description', 'is_default', 'is_active', 'metadata'
            ];
            
            updateableFields.forEach(field => {
                if (data[field] !== undefined) {
                    fields.push(`${field} = $${paramIndex++}`);
                    
                    if (field === 'metadata' && typeof data[field] === 'object') {
                        values.push(JSON.stringify(data[field]));
                    } else {
                        values.push(data[field]);
                    }
                }
            });
            
            if (fields.length === 0) {
                throw new Error('Не вказано полів для оновлення');
            }
            
            // Додаємо updated_at
            fields.push(`updated_at = $${paramIndex++}`);
            values.push(new Date());
            
            // Додаємо id для WHERE
            values.push(id);
            
            const query = `
                UPDATE billing.invoice_templates 
                SET ${fields.join(', ')} 
                WHERE id = $${paramIndex}
                RETURNING *
            `;
            
            const result = await client.query(query, values);
            
            // Аудит
            await AuditService.log({
                userId,
                actionType: 'INVOICE_TEMPLATE_UPDATE',
                entityType: 'INVOICE_TEMPLATE',
                entityId: id,
                oldValues: oldData,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'billing',
                tableName: 'invoice_templates',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return result.rows[0];
        } catch (error) {
            console.error('Error updating invoice template:', error);
            throw error;
        }
    }

    // Видалення шаблону
    static async deleteTemplate(client, id, userId, req) {
        try {
            // Перевірка використання шаблону
            const usageCheck = await client.query(
                'SELECT COUNT(*) FROM services.invoices WHERE template_id = $1',
                [id]
            );
            
            if (parseInt(usageCheck.rows[0].count) > 0) {
                throw new Error('Неможливо видалити шаблон, який використовується у рахунках');
            }
            
            // Отримання даних для аудиту
            const templateData = await client.query(
                'SELECT * FROM billing.invoice_templates WHERE id = $1',
                [id]
            );
            
            if (templateData.rows.length === 0) {
                throw new Error('Шаблон не знайдено');
            }
            
            const oldData = templateData.rows[0];
            
            // Видалення шаблону
            await client.query(
                'DELETE FROM billing.invoice_templates WHERE id = $1',
                [id]
            );
            
            // Аудит
            await AuditService.log({
                userId,
                actionType: 'INVOICE_TEMPLATE_DELETE',
                entityType: 'INVOICE_TEMPLATE',
                entityId: id,
                oldValues: oldData,
                ipAddress: req.ip,
                tableSchema: 'billing',
                tableName: 'invoice_templates',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return { success: true };
        } catch (error) {
            console.error('Error deleting invoice template:', error);
            throw error;
        }
    }

    // Отримання шаблону за замовчуванням
    static async getDefaultTemplate() {
        try {
            const query = `
                SELECT * FROM billing.invoice_templates 
                WHERE is_default = true AND is_active = true
                LIMIT 1
            `;
            
            const result = await pool.query(query);
            
            if (result.rows.length > 0) {
                return result.rows[0];
            }
            
            // Якщо немає шаблону за замовчуванням, повертаємо перший активний
            const fallbackQuery = `
                SELECT * FROM billing.invoice_templates 
                WHERE is_active = true
                ORDER BY created_at DESC
                LIMIT 1
            `;
            
            const fallbackResult = await pool.query(fallbackQuery);
            return fallbackResult.rows.length > 0 ? fallbackResult.rows[0] : null;
        } catch (error) {
            console.error('Error fetching default invoice template:', error);
            throw error;
        }
    }
}

module.exports = InvoiceTemplatesService;