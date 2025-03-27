const { pool } = require('../database');
const AuditService = require('./auditService');
const { ENTITY_TYPES, AUDIT_TYPES } = require('../constants/constants');
const path = require('path');
const fs = require('fs');

class CompanyService {
    // Отримання даних організації
    static async getOrganizationDetails() {
        try {
            const query = `
                SELECT * FROM company.view_organization_full
                LIMIT 1
            `;
            
            const result = await pool.query(query);
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            console.error('Error fetching organization details:', error);
            throw error;
        }
    }

    // Створення або оновлення даних організації
    static async saveOrganizationDetails(client, data, userId, req) {
        try {
            // Перевірка, чи вже є запис для організації
            const existingRecord = await client.query(
                'SELECT id FROM company.organization_details LIMIT 1'
            );

            let organizationId;
            let oldData = null;
            let actionType = 'ORGANIZATION_CREATE';

            if (existingRecord.rows.length > 0) {
                // Оновлення існуючого запису
                organizationId = existingRecord.rows[0].id;
                oldData = await client.query(
                    'SELECT * FROM company.organization_details WHERE id = $1',
                    [organizationId]
                );
                oldData = oldData.rows[0];
                actionType = 'ORGANIZATION_UPDATE';

                // Підготовка полів для оновлення
                const fields = [];
                const values = [];
                let paramIndex = 1;
                
                // Доступні поля для оновлення
                const updateableFields = [
                    'legal_name', 'short_name', 'legal_form', 'edrpou', 
                    'tax_number', 'legal_address', 'actual_address', 
                    'phone', 'email', 'website', 'director_name', 
                    'director_position', 'accountant_name', 'logo_path', 
                    'is_active'
                ];
                
                updateableFields.forEach(field => {
                    if (data[field] !== undefined) {
                        fields.push(`${field} = $${paramIndex++}`);
                        values.push(data[field]);
                    }
                });
                
                if (fields.length === 0) {
                    throw new Error('Не вказано полів для оновлення');
                }
                
                // Додаємо updated_at
                fields.push(`updated_at = $${paramIndex++}`);
                values.push(new Date());
                
                // Додаємо id для WHERE
                values.push(organizationId);
                
                const query = `
                    UPDATE company.organization_details 
                    SET ${fields.join(', ')} 
                    WHERE id = $${paramIndex}
                    RETURNING *
                `;
                
                const result = await client.query(query, values);
                organizationId = result.rows[0].id;
            } else {
                // Створення нового запису
                const requiredFields = ['legal_name'];
                
                for (const field of requiredFields) {
                    if (!data[field]) {
                        throw new Error(`Поле ${field} є обов'язковим`);
                    }
                }
                
                const query = `
                    INSERT INTO company.organization_details (
                        legal_name, short_name, legal_form, edrpou, 
                        tax_number, legal_address, actual_address, 
                        phone, email, website, director_name, 
                        director_position, accountant_name, logo_path, 
                        is_active
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
                    )
                    RETURNING *
                `;
                
                const result = await client.query(query, [
                    data.legal_name,
                    data.short_name || null,
                    data.legal_form || null,
                    data.edrpou || null,
                    data.tax_number || null,
                    data.legal_address || null,
                    data.actual_address || null,
                    data.phone || null,
                    data.email || null,
                    data.website || null,
                    data.director_name || null,
                    data.director_position || null,
                    data.accountant_name || null,
                    data.logo_path || null,
                    data.is_active !== undefined ? data.is_active : true
                ]);
                
                organizationId = result.rows[0].id;
            }
            
            // Аудит
            await AuditService.log({
                userId,
                actionType,
                entityType: 'ORGANIZATION',
                entityId: organizationId,
                oldValues: oldData,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'company',
                tableName: 'organization_details',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return {
                id: organizationId
            };
        } catch (error) {
            console.error('Error saving organization details:', error);
            throw error;
        }
    }

    // Отримання банківських рахунків
    static async getBankAccounts(organizationId = null) {
        try {
            let query = `
                SELECT * FROM company.bank_accounts 
                WHERE is_active = true
            `;
            
            const params = [];
            if (organizationId) {
                query += ' AND organization_id = $1';
                params.push(organizationId);
            }
            
            query += ' ORDER BY is_default DESC, created_at DESC';
            
            const result = await pool.query(query, params);
            return result.rows;
        } catch (error) {
            console.error('Error fetching bank accounts:', error);
            throw error;
        }
    }

    // Створення банківського рахунку
    static async createBankAccount(client, data, userId, req) {
        try {
            // Отримання ID організації, якщо не вказано
            if (!data.organization_id) {
                const orgResult = await client.query(
                    'SELECT id FROM company.organization_details LIMIT 1'
                );
                
                if (orgResult.rows.length === 0) {
                    throw new Error('Необхідно спочатку створити дані організації');
                }
                
                data.organization_id = orgResult.rows[0].id;
            }
            
            // Перевірка обов'язкових полів
            const requiredFields = ['bank_name', 'account_number'];
            
            for (const field of requiredFields) {
                if (!data[field]) {
                    throw new Error(`Поле ${field} є обов'язковим`);
                }
            }
            
            // Якщо позначено як основний, скидаємо прапорець у інших рахунків
            if (data.is_default) {
                await client.query(
                    'UPDATE company.bank_accounts SET is_default = false WHERE organization_id = $1',
                    [data.organization_id]
                );
            }
            
            const query = `
                INSERT INTO company.bank_accounts (
                    organization_id, bank_name, account_number, iban, 
                    mfo, swift_code, currency, is_default, is_active, description
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
                )
                RETURNING *
            `;
            
            const result = await client.query(query, [
                data.organization_id,
                data.bank_name,
                data.account_number,
                data.iban || null,
                data.mfo || null,
                data.swift_code || null,
                data.currency || 'UAH',
                data.is_default !== undefined ? data.is_default : false,
                data.is_active !== undefined ? data.is_active : true,
                data.description || null
            ]);
            
            // Аудит
            await AuditService.log({
                userId,
                actionType: 'BANK_ACCOUNT_CREATE',
                entityType: 'BANK_ACCOUNT',
                entityId: result.rows[0].id,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'company',
                tableName: 'bank_accounts',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return result.rows[0];
        } catch (error) {
            console.error('Error creating bank account:', error);
            throw error;
        }
    }

    // Оновлення банківського рахунку
    static async updateBankAccount(client, id, data, userId, req) {
        try {
            // Отримання поточних даних для аудиту
            const currentData = await client.query(
                'SELECT * FROM company.bank_accounts WHERE id = $1',
                [id]
            );
            
            if (currentData.rows.length === 0) {
                throw new Error('Банківський рахунок не знайдено');
            }
            
            const oldData = currentData.rows[0];
            
            // Підготовка полів для оновлення
            const fields = [];
            const values = [];
            let paramIndex = 1;
            
            // Доступні поля для оновлення
            const updateableFields = [
                'bank_name', 'account_number', 'iban', 'mfo', 
                'swift_code', 'currency', 'is_default', 'is_active', 'description'
            ];
            
            updateableFields.forEach(field => {
                if (data[field] !== undefined) {
                    fields.push(`${field} = $${paramIndex++}`);
                    values.push(data[field]);
                }
            });
            
            if (fields.length === 0) {
                throw new Error('Не вказано полів для оновлення');
            }
            
            // Якщо позначено як основний, скидаємо прапорець у інших рахунків
            if (data.is_default) {
                await client.query(
                    'UPDATE company.bank_accounts SET is_default = false WHERE organization_id = $1 AND id != $2',
                    [oldData.organization_id, id]
                );
            }
            
            // Додаємо updated_at
            fields.push(`updated_at = $${paramIndex++}`);
            values.push(new Date());
            
            // Додаємо id для WHERE
            values.push(id);
            
            const query = `
                UPDATE company.bank_accounts 
                SET ${fields.join(', ')} 
                WHERE id = $${paramIndex}
                RETURNING *
            `;
            
            const result = await client.query(query, values);
            
            // Аудит
            await AuditService.log({
                userId,
                actionType: 'BANK_ACCOUNT_UPDATE',
                entityType: 'BANK_ACCOUNT',
                entityId: id,
                oldValues: oldData,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'company',
                tableName: 'bank_accounts',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return result.rows[0];
        } catch (error) {
            console.error('Error updating bank account:', error);
            throw error;
        }
    }

    // Видалення банківського рахунку
    static async deleteBankAccount(client, id, userId, req) {
        try {
            // Отримання поточних даних для аудиту
            const currentData = await client.query(
                'SELECT * FROM company.bank_accounts WHERE id = $1',
                [id]
            );
            
            if (currentData.rows.length === 0) {
                throw new Error('Банківський рахунок не знайдено');
            }
            
            const oldData = currentData.rows[0];
            
            // Видалення рахунку
            await client.query(
                'DELETE FROM company.bank_accounts WHERE id = $1',
                [id]
            );
            
            // Аудит
            await AuditService.log({
                userId,
                actionType: 'BANK_ACCOUNT_DELETE',
                entityType: 'BANK_ACCOUNT',
                entityId: id,
                oldValues: oldData,
                ipAddress: req.ip,
                tableSchema: 'company',
                tableName: 'bank_accounts',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return {
                success: true
            };
        } catch (error) {
            console.error('Error deleting bank account:', error);
            throw error;
        }
    }

    // Отримання юридичних документів
    static async getLegalDocuments(organizationId = null) {
        try {
            let query = `
                SELECT * FROM company.legal_documents
            `;
            
            const params = [];
            if (organizationId) {
                query += ' WHERE organization_id = $1';
                params.push(organizationId);
            }
            
            query += ' ORDER BY effective_date DESC, created_at DESC';
            
            const result = await pool.query(query, params);
            return result.rows;
        } catch (error) {
            console.error('Error fetching legal documents:', error);
            throw error;
        }
    }

    // Завантаження юридичного документа
    static async uploadLegalDocument(client, data, file, userId, req) {
        try {
            // Отримання ID організації, якщо не вказано
            if (!data.organization_id) {
                const orgResult = await client.query(
                    'SELECT id FROM company.organization_details LIMIT 1'
                );
                
                if (orgResult.rows.length === 0) {
                    throw new Error('Необхідно спочатку створити дані організації');
                }
                
                data.organization_id = orgResult.rows[0].id;
            }
            
            // Перевірка обов'язкових полів
            if (!file) {
                throw new Error('Файл не вказано');
            }
            
            if (!data.document_name) {
                data.document_name = file.originalname;
            }
            
            if (!data.document_type) {
                data.document_type = path.extname(file.originalname).substring(1).toLowerCase();
            }
            
            const query = `
                INSERT INTO company.legal_documents (
                    organization_id, document_name, document_type, 
                    file_path, file_size, effective_date, expiry_date, 
                    description, uploaded_by
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9
                )
                RETURNING *
            `;
            
            const result = await client.query(query, [
                data.organization_id,
                data.document_name,
                data.document_type,
                file.path.replace(process.env.UPLOAD_DIR, ''),
                file.size,
                data.effective_date ? new Date(data.effective_date) : null,
                data.expiry_date ? new Date(data.expiry_date) : null,
                data.description || null,
                userId
            ]);
            
            // Аудит
            await AuditService.log({
                userId,
                actionType: 'LEGAL_DOCUMENT_UPLOAD',
                entityType: 'LEGAL_DOCUMENT',
                entityId: result.rows[0].id,
                newValues: {
                    ...data,
                    file_name: file.originalname,
                    file_size: file.size
                },
                ipAddress: req.ip,
                tableSchema: 'company',
                tableName: 'legal_documents',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return result.rows[0];
        } catch (error) {
            console.error('Error uploading legal document:', error);
            throw error;
        }
    }

    // Видалення юридичного документа
    static async deleteLegalDocument(client, id, userId, req) {
        try {
            // Отримання поточних даних для аудиту
            const currentData = await client.query(
                'SELECT * FROM company.legal_documents WHERE id = $1',
                [id]
            );
            
            if (currentData.rows.length === 0) {
                throw new Error('Юридичний документ не знайдено');
            }
            
            const oldData = currentData.rows[0];
            
            // Видалення файлу
            if (oldData.file_path) {
                const filePath = path.join(process.env.UPLOAD_DIR, oldData.file_path);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }
            
            // Видалення запису
            await client.query(
                'DELETE FROM company.legal_documents WHERE id = $1',
                [id]
            );
            
            // Аудит
            await AuditService.log({
                userId,
                actionType: 'LEGAL_DOCUMENT_DELETE',
                entityType: 'LEGAL_DOCUMENT',
                entityId: id,
                oldValues: oldData,
                ipAddress: req.ip,
                tableSchema: 'company',
                tableName: 'legal_documents',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return {
                success: true
            };
        } catch (error) {
            console.error('Error deleting legal document:', error);
            throw error;
        }
    }

    // Отримання налаштувань системи
    static async getSystemSettings(category = null) {
        try {
            let query = 'SELECT * FROM company.system_settings';
            const params = [];
            
            if (category) {
                query += ' WHERE category = $1';
                params.push(category);
            }
            
            query += ' ORDER BY category, key';
            
            const result = await pool.query(query, params);
            return result.rows;
        } catch (error) {
            console.error('Error fetching system settings:', error);
            throw error;
        }
    }

    // Отримання конкретного налаштування
    static async getSystemSetting(category, key) {
        try {
            const query = `
                SELECT * FROM company.system_settings
                WHERE category = $1 AND key = $2
                LIMIT 1
            `;
            
            const result = await pool.query(query, [category, key]);
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            console.error('Error fetching system setting:', error);
            throw error;
        }
    }

    // Збереження налаштування системи
    static async saveSystemSetting(client, data, userId, req) {
        try {
            // Перевірка обов'язкових полів
            const requiredFields = ['category', 'key', 'value'];
            
            for (const field of requiredFields) {
                if (!data[field] && data[field] !== 0 && data[field] !== false) {
                    throw new Error(`Поле ${field} є обов'язковим`);
                }
            }
            
            // Перевірка, чи вже існує налаштування
            const existingResult = await client.query(
                'SELECT * FROM company.system_settings WHERE category = $1 AND key = $2',
                [data.category, data.key]
            );
            
            let result;
            let actionType;
            let oldData = null;
            
            if (existingResult.rows.length > 0) {
                // Оновлення існуючого налаштування
                oldData = existingResult.rows[0];
                actionType = 'SYSTEM_SETTING_UPDATE';
                
                result = await client.query(
                    `UPDATE company.system_settings 
                     SET value = $1, value_type = $2, description = $3, 
                         is_public = $4, created_by = $5, updated_at = $6
                     WHERE category = $7 AND key = $8
                     RETURNING *`,
                    [
                        data.value,
                        data.value_type || this.determineValueType(data.value),
                        data.description || oldData.description,
                        data.is_public !== undefined ? data.is_public : oldData.is_public,
                        userId,
                        new Date(),
                        data.category,
                        data.key
                    ]
                );
            } else {
                // Створення нового налаштування
                actionType = 'SYSTEM_SETTING_CREATE';
                
                result = await client.query(
                    `INSERT INTO company.system_settings (
                         category, key, value, value_type, description, 
                         is_public, created_by
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                     RETURNING *`,
                    [
                        data.category,
                        data.key,
                        data.value,
                        data.value_type || this.determineValueType(data.value),
                        data.description || null,
                        data.is_public !== undefined ? data.is_public : false,
                        userId
                    ]
                );
            }
            
            // Аудит
            await AuditService.log({
                userId,
                actionType,
                entityType: 'SYSTEM_SETTING',
                entityId: result.rows[0].id,
                oldValues: oldData,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'company',
                tableName: 'system_settings',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return result.rows[0];
        } catch (error) {
            console.error('Error saving system setting:', error);
            throw error;
        }
    }

    // Видалення налаштування системи
    static async deleteSystemSetting(client, id, userId, req) {
        try {
            // Отримання поточних даних для аудиту
            const currentData = await client.query(
                'SELECT * FROM company.system_settings WHERE id = $1',
                [id]
            );
            
            if (currentData.rows.length === 0) {
                throw new Error('Налаштування не знайдено');
            }
            
            const oldData = currentData.rows[0];
            
            // Видалення налаштування
            await client.query(
                'DELETE FROM company.system_settings WHERE id = $1',
                [id]
            );
            
            // Аудит
            await AuditService.log({
                userId,
                actionType: 'SYSTEM_SETTING_DELETE',
                entityType: 'SYSTEM_SETTING',
                entityId: id,
                oldValues: oldData,
                ipAddress: req.ip,
                tableSchema: 'company',
                tableName: 'system_settings',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return {
                success: true
            };
        } catch (error) {
            console.error('Error deleting system setting:', error);
            throw error;
        }
    }

    // Допоміжний метод для визначення типу значення
    static determineValueType(value) {
        if (value === null || value === undefined) {
            return 'string';
        }
        
        if (typeof value === 'number') {
            return 'number';
        }
        
        if (typeof value === 'boolean') {
            return 'boolean';
        }
        
        if (typeof value === 'object') {
            try {
                JSON.stringify(value);
                return 'json';
            } catch (e) {
                return 'string';
            }
        }
        
        // Перевірка на дату
        const dateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/;
        if (dateRegex.test(value)) {
            return 'date';
        }
        
        return 'string';
    }
}

module.exports = CompanyService;