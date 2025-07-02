const { pool } = require('../database');
const fs = require('fs').promises;
const path = require('path');
const AuditService = require('./auditService');
const { ENTITY_TYPES, AUDIT_TYPES } = require('../constants/constants');

class ReportsService {
    // Отримання списку звітів з фільтрацією та пагінацією
    static async getReports(filters) {
        const {
            page = 1,
            perPage = 10,
            sortBy = 'name',
            descending = false,
            search = '',
            is_active = null,
            output_format = null
        } = filters;

        let conditions = [];
        let params = [];
        let paramIndex = 1;

        if (search) {
            conditions.push(`(
                rd.name ILIKE $${paramIndex} OR
                rd.code ILIKE $${paramIndex} OR
                rd.description ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (is_active !== null) {
            conditions.push(`rd.is_active = $${paramIndex}`);
            params.push(is_active === 'true' || is_active === true);
            paramIndex++;
        }

        if (output_format) {
            conditions.push(`rd.output_format = $${paramIndex}`);
            params.push(output_format);
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const orderDirection = descending === 'true' || descending === true ? 'DESC' : 'ASC';
        
        let orderByField;
        switch(sortBy) {
            case 'name':
                orderByField = 'rd.name';
                break;
            case 'code':
                orderByField = 'rd.code';
                break;
            case 'output_format':
                orderByField = 'rd.output_format';
                break;
            case 'created_at':
                orderByField = 'rd.created_at';
                break;
            default:
                orderByField = 'rd.name';
        }

        const limit = perPage === 'All' ? null : parseInt(perPage);
        const offset = limit ? (parseInt(page) - 1) * limit : 0;
        
        let query = `
            SELECT 
                rd.*,
                u.email as created_by_email,
                u.first_name || ' ' || u.last_name as created_by_name,
                COUNT(DISTINCT pra.id) as pages_assigned,
                COUNT(DISTINCT rp.id) as parameters_count,
                COUNT(DISTINCT reh.id) as execution_count,
                MAX(reh.executed_at) as last_execution
            FROM reports.report_definitions rd
            LEFT JOIN auth.users u ON rd.created_by = u.id
            LEFT JOIN reports.page_report_assignments pra ON rd.id = pra.report_id AND pra.is_visible = true
            LEFT JOIN reports.report_parameters rp ON rd.id = rp.report_id
            LEFT JOIN reports.report_execution_history reh ON rd.id = reh.report_id
            ${whereClause}
            GROUP BY rd.id, u.email, u.first_name, u.last_name
            ORDER BY ${orderByField} ${orderDirection}
        `;

        if (limit !== null) {
            query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);
        }

        const countQuery = `
            SELECT COUNT(DISTINCT rd.id) FROM reports.report_definitions rd
            ${whereClause}
        `;

        const [reportsResult, countResult] = await Promise.all([
            pool.query(query, params),
            pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : [])
        ]);

        return {
            reports: reportsResult.rows,
            total: parseInt(countResult.rows[0].count)
        };
    }

    // Отримання звіту за ID з детальною інформацією
    static async getReportById(id) {
        const reportQuery = `
            SELECT 
                rd.*,
                u.email as created_by_email,
                u.first_name || ' ' || u.last_name as created_by_name,
                json_agg(
                    DISTINCT jsonb_build_object(
                        'id', rp.id,
                        'parameter_name', rp.parameter_name,
                        'parameter_type', rp.parameter_type,
                        'display_name', rp.display_name,
                        'description', rp.description,
                        'is_required', rp.is_required,
                        'default_value', rp.default_value,
                        'validation_rules', rp.validation_rules,
                        'options', rp.options,
                        'ordering', rp.ordering
                    ) ORDER BY rp.ordering
                ) FILTER (WHERE rp.id IS NOT NULL) as parameters,
                json_agg(
                    DISTINCT jsonb_build_object(
                        'id', pra.id,
                        'page_identifier', pra.page_identifier,
                        'page_title', pra.page_title,
                        'display_order', pra.display_order,
                        'is_visible', pra.is_visible,
                        'auto_execute', pra.auto_execute
                    )
                ) FILTER (WHERE pra.id IS NOT NULL) as page_assignments
            FROM reports.report_definitions rd
            LEFT JOIN auth.users u ON rd.created_by = u.id
            LEFT JOIN reports.report_parameters rp ON rd.id = rp.report_id
            LEFT JOIN reports.page_report_assignments pra ON rd.id = pra.report_id
            WHERE rd.id = $1
            GROUP BY rd.id, u.email, u.first_name, u.last_name
        `;

        const result = await pool.query(reportQuery, [id]);
        
        if (result.rows.length === 0) {
            return null;
        }

        return result.rows[0];
    }

    // Створення нового звіту
    static async createReport(client, data, userId, req) {
        try {
            const { 
                name, code, description, sql_query, parameters_schema,
                output_format, chart_config, execution_timeout, cache_duration,
                parameters, page_assignments
            } = data;

            // Створення звіту
            const result = await client.query(
                `INSERT INTO reports.report_definitions (
                    name, code, description, sql_query, parameters_schema,
                    output_format, chart_config, execution_timeout, cache_duration,
                    created_by
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING *`,
                [
                    name, code, description, sql_query, parameters_schema || {},
                    output_format || 'table', chart_config || {}, 
                    execution_timeout || 30, cache_duration || 0, userId
                ]
            );

            const newReport = result.rows[0];

            // Додавання параметрів, якщо вони є
            if (parameters && Array.isArray(parameters)) {
                for (const param of parameters) {
                    await client.query(
                        `INSERT INTO reports.report_parameters (
                            report_id, parameter_name, parameter_type, display_name,
                            description, is_required, default_value, validation_rules,
                            options, ordering
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                        [
                            newReport.id, param.parameter_name, param.parameter_type,
                            param.display_name, param.description, param.is_required || false,
                            param.default_value, param.validation_rules || {},
                            param.options || [], param.ordering || 0
                        ]
                    );
                }
            }

            // Додавання прив'язок до сторінок, якщо вони є
            if (page_assignments && Array.isArray(page_assignments)) {
                for (const assignment of page_assignments) {
                    await client.query(
                        `INSERT INTO reports.page_report_assignments (
                            report_id, page_identifier, page_title, display_order,
                            is_visible, auto_execute, created_by
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [
                            newReport.id, assignment.page_identifier, assignment.page_title,
                            assignment.display_order || 0, assignment.is_visible !== false,
                            assignment.auto_execute || false, userId
                        ]
                    );
                }
            }

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'CREATE',
                entityType: 'REPORT',
                entityId: newReport.id,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'reports',
                tableName: 'report_definitions',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return newReport;
        } catch (error) {
            if (error.code === '23505') {
                if (error.constraint === 'report_definitions_code_key') {
                    throw new Error('Звіт з таким кодом вже існує');
                }
            }
            throw error;
        }
    }

    // Оновлення існуючого звіту
    static async updateReport(client, id, data, userId, req) {
        try {
            // Отримання поточних даних звіту для аудиту
            const currentReport = await client.query(
                'SELECT * FROM reports.report_definitions WHERE id = $1',
                [id]
            );

            if (currentReport.rows.length === 0) {
                throw new Error('Звіт не знайдений');
            }

            const oldData = currentReport.rows[0];

            // Підготовка оновлених даних
            const updateFields = [];
            const updateValues = [];
            let paramIndex = 1;

            const fieldsToUpdate = [
                'name', 'code', 'description', 'sql_query', 'parameters_schema',
                'output_format', 'chart_config', 'execution_timeout', 'cache_duration', 'is_active'
            ];

            for (const field of fieldsToUpdate) {
                if (data[field] !== undefined) {
                    updateFields.push(`${field} = $${paramIndex++}`);
                    updateValues.push(data[field]);
                }
            }

            updateFields.push(`updated_at = $${paramIndex++}`);
            updateValues.push(new Date());
            updateValues.push(id);

            // Оновлення звіту
            const result = await client.query(
                `UPDATE reports.report_definitions 
                 SET ${updateFields.join(', ')}
                 WHERE id = $${paramIndex}
                 RETURNING *`,
                updateValues
            );

            // Оновлення параметрів, якщо вони є
            if (data.parameters && Array.isArray(data.parameters)) {
                // Видалення існуючих параметрів
                await client.query(
                    'DELETE FROM reports.report_parameters WHERE report_id = $1',
                    [id]
                );

                // Додавання нових параметрів
                for (const param of data.parameters) {
                    await client.query(
                        `INSERT INTO reports.report_parameters (
                            report_id, parameter_name, parameter_type, display_name,
                            description, is_required, default_value, validation_rules,
                            options, ordering
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                        [
                            id, param.parameter_name, param.parameter_type,
                            param.display_name, param.description, param.is_required || false,
                            param.default_value, param.validation_rules || {},
                            param.options || [], param.ordering || 0
                        ]
                    );
                }
            }

            // Оновлення прив'язок до сторінок, якщо вони є
            if (data.page_assignments && Array.isArray(data.page_assignments)) {
                // Видалення існуючих прив'язок
                await client.query(
                    'DELETE FROM reports.page_report_assignments WHERE report_id = $1',
                    [id]
                );

                // Додавання нових прив'язок
                for (const assignment of data.page_assignments) {
                    await client.query(
                        `INSERT INTO reports.page_report_assignments (
                            report_id, page_identifier, page_title, display_order,
                            is_visible, auto_execute, created_by
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [
                            id, assignment.page_identifier, assignment.page_title,
                            assignment.display_order || 0, assignment.is_visible !== false,
                            assignment.auto_execute || false, userId
                        ]
                    );
                }
            }

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'UPDATE',
                entityType: 'REPORT',
                entityId: id,
                oldValues: oldData,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'reports',
                tableName: 'report_definitions',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return result.rows[0];
        } catch (error) {
            if (error.code === '23505') {
                if (error.constraint === 'report_definitions_code_key') {
                    throw new Error('Звіт з таким кодом вже існує');
                }
            }
            throw error;
        }
    }

    // Видалення звіту
    static async deleteReport(client, id, userId, req) {
        try {
            // Отримання даних звіту для аудиту
            const reportData = await client.query(
                'SELECT * FROM reports.report_definitions WHERE id = $1',
                [id]
            );

            if (reportData.rows.length === 0) {
                throw new Error('Звіт не знайдений');
            }

            // Видалення кешу звіту
            await client.query(
                'DELETE FROM reports.report_cache WHERE report_id = $1',
                [id]
            );

            // Видалення дозволів звіту
            await client.query(
                'DELETE FROM reports.report_permissions WHERE report_id = $1',
                [id]
            );

            // Видалення прив'язок до сторінок
            await client.query(
                'DELETE FROM reports.page_report_assignments WHERE report_id = $1',
                [id]
            );

            // Видалення параметрів
            await client.query(
                'DELETE FROM reports.report_parameters WHERE report_id = $1',
                [id]
            );

            // Видалення звіту
            await client.query(
                'DELETE FROM reports.report_definitions WHERE id = $1',
                [id]
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'DELETE',
                entityType: 'REPORT',
                entityId: id,
                oldValues: reportData.rows[0],
                ipAddress: req.ip,
                tableSchema: 'reports',
                tableName: 'report_definitions',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return { success: true };
        } catch (error) {
            throw error;
        }
    }

    // Виконання звіту
    static async executeReport(reportId, parameters = {}, userId, userType = 'staff', clientId = null, pageIdentifier = null, req) {
        try {
            // Використовуємо функцію з БД
            const result = await pool.query(
                'SELECT * FROM reports.execute_report($1, $2, $3, $4, $5, $6, $7, $8)',
                [
                    reportId,
                    JSON.stringify(parameters),
                    userId,
                    userType,
                    clientId,
                    pageIdentifier,
                    req?.ip || null,
                    req?.get('User-Agent') || null
                ]
            );

            return result.rows[0];
        } catch (error) {
            console.error('Error executing report:', error);
            throw error;
        }
    }

    // Отримання звітів для конкретної сторінки
    static async getPageReports(pageIdentifier, userId = null, userType = 'staff', clientId = null) {
        try {
            const result = await pool.query(
                'SELECT * FROM reports.get_page_reports($1, $2, $3, $4)',
                [pageIdentifier, userId, userType, clientId]
            );

            return result.rows;
        } catch (error) {
            console.error('Error getting page reports:', error);
            throw error;
        }
    }

    // Отримання історії виконання звіту
    static async getExecutionHistory(reportId, filters = {}) {
        const {
            page = 1,
            perPage = 10,
            status = null,
            executed_by = null
        } = filters;

        let conditions = ['reh.report_id = $1'];
        let params = [reportId];
        let paramIndex = 2;

        if (status) {
            conditions.push(`reh.status = $${paramIndex++}`);
            params.push(status);
        }

        if (executed_by) {
            conditions.push(`reh.executed_by = $${paramIndex++}`);
            params.push(executed_by);
        }

        const whereClause = 'WHERE ' + conditions.join(' AND ');
        const limit = parseInt(perPage);
        const offset = (parseInt(page) - 1) * limit;

        const query = `
            SELECT 
                reh.*,
                u.email as executed_by_email,
                u.first_name || ' ' || u.last_name as executed_by_name
            FROM reports.report_execution_history reh
            LEFT JOIN auth.users u ON reh.executed_by = u.id
            ${whereClause}
            ORDER BY reh.executed_at DESC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;

        const countQuery = `
            SELECT COUNT(*) FROM reports.report_execution_history reh
            ${whereClause}
        `;

        params.push(limit, offset);

        const [historyResult, countResult] = await Promise.all([
            pool.query(query, params),
            pool.query(countQuery, params.slice(0, paramIndex - 1))
        ]);

        return {
            history: historyResult.rows,
            total: parseInt(countResult.rows[0].count)
        };
    }

    // Очищення застарілого кешу
    static async clearExpiredCache() {
        try {
            const result = await pool.query('SELECT reports.clear_expired_cache()');
            return result.rows[0].clear_expired_cache;
        } catch (error) {
            console.error('Error clearing expired cache:', error);
            throw error;
        }
    }

    // Завантаження звітів з файлової системи (для майбутнього використання)
    static async loadReportsFromFiles(reportsDir = './reports') {
        try {
            // Ця функція буде розширена пізніше для читання JSON/YAML файлів
            console.log('Loading reports from directory:', reportsDir);
            // TODO: Implement file-based report loading
            return { success: true, message: 'File-based loading not implemented yet' };
        } catch (error) {
            console.error('Error loading reports from files:', error);
            throw error;
        }
    }
}

module.exports = ReportsService;