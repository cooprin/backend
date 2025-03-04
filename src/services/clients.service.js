const { pool } = require('../database');
const AuditService = require('./auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

class ClientService {
    // Отримання списку клієнтів з фільтрацією та пагінацією
    static async getClients(filters) {
        const {
            page = 1,
            perPage = 10,
            sortBy = 'name',
            descending = false,
            search = '',
            is_active = null
        } = filters;

        let conditions = [];
        let params = [];
        let paramIndex = 1;

        if (search) {
            conditions.push(`(
                c.name ILIKE $${paramIndex} OR
                c.email ILIKE $${paramIndex} OR
                c.contact_person ILIKE $${paramIndex} OR
                c.phone ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (is_active !== null) {
            conditions.push(`c.is_active = $${paramIndex}`);
            params.push(is_active === 'true' || is_active === true);
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const orderDirection = descending === 'true' || descending === true ? 'DESC' : 'ASC';
        
        // Визначення поля для сортування
        let orderByField;
        switch(sortBy) {
            case 'name':
                orderByField = 'c.name';
                break;
            case 'contact_person':
                orderByField = 'c.contact_person';
                break;
            case 'email':
                orderByField = 'c.email';
                break;
            case 'objects_count':
                orderByField = 'objects_count';
                break;
            case 'created_at':
                orderByField = 'c.created_at';
                break;
            default:
                orderByField = 'c.name';
        }

        // Обробка опції "всі записи" для експорту
        const limit = perPage === 'All' ? null : parseInt(perPage);
        const offset = limit ? (parseInt(page) - 1) * limit : 0;
        
        let query = `
            SELECT 
                c.*,
                COUNT(DISTINCT o.id) as objects_count,
                COUNT(DISTINCT cd.id) as documents_count
            FROM clients.clients c
            LEFT JOIN wialon.objects o ON c.id = o.client_id
            LEFT JOIN clients.client_documents cd ON c.id = cd.client_id
            ${whereClause}
            GROUP BY c.id
            ORDER BY ${orderByField} ${orderDirection}
        `;

        if (limit !== null) {
            query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);
        }

        const countQuery = `
            SELECT COUNT(*) FROM clients.clients c
            ${whereClause}
        `;

        const [clientsResult, countResult] = await Promise.all([
            pool.query(query, params),
            pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : [])
        ]);

        return {
            clients: clientsResult.rows,
            total: parseInt(countResult.rows[0].count)
        };
    }

    // Отримання клієнта за ID з детальною інформацією
    static async getClientById(id) {
        const clientQuery = `
            SELECT 
                c.*,
                COUNT(DISTINCT o.id) as objects_count,
                COUNT(DISTINCT cd.id) as documents_count,
                json_agg(
                    DISTINCT jsonb_build_object(
                        'id', o.id,
                        'name', o.name,
                        'wialon_id', o.wialon_id,
                        'status', o.status
                    )
                ) FILTER (WHERE o.id IS NOT NULL) as objects,
                json_agg(
                    DISTINCT jsonb_build_object(
                        'id', cd.id,
                        'document_name', cd.document_name,
                        'document_type', cd.document_type,
                        'file_path', cd.file_path,
                        'created_at', cd.created_at
                    )
                ) FILTER (WHERE cd.id IS NOT NULL) as documents,
                json_agg(
                    DISTINCT jsonb_build_object(
                        'id', cnt.id,
                        'first_name', cnt.first_name,
                        'last_name', cnt.last_name,
                        'position', cnt.position,
                        'phone', cnt.phone,
                        'email', cnt.email,
                        'is_primary', cnt.is_primary
                    )
                ) FILTER (WHERE cnt.id IS NOT NULL) as contacts
            FROM clients.clients c
            LEFT JOIN wialon.objects o ON c.id = o.client_id
            LEFT JOIN clients.client_documents cd ON c.id = cd.client_id
            LEFT JOIN clients.contacts cnt ON c.id = cnt.client_id
            WHERE c.id = $1
            GROUP BY c.id
        `;

        const result = await pool.query(clientQuery, [id]);
        
        if (result.rows.length === 0) {
            return null;
        }

        return result.rows[0];
    }

    // Створення нового клієнта
    static async createClient(client, data, userId, req) {
        try {
            // Перевірка наявності клієнта з такою ж назвою чи контактною інформацією
            const existingClient = await client.query(
                'SELECT id FROM clients.clients WHERE name = $1 OR email = $2',
                [data.name, data.email]
            );

            if (existingClient.rows.length > 0) {
                throw new Error('Клієнт з такою назвою або email вже існує');
            }

            const { 
                name, full_name, description, address, contact_person, 
                phone, email, wialon_id, wialon_username, is_active 
            } = data;

            // Створення клієнта
            const result = await client.query(
                `INSERT INTO clients.clients (
                    name, full_name, description, address, contact_person, 
                    phone, email, wialon_id, wialon_username, is_active
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING *`,
                [
                    name, full_name, description, address, contact_person, 
                    phone, email, wialon_id, wialon_username, is_active !== undefined ? is_active : true
                ]
            );

            const newClient = result.rows[0];

            // Додавання контактів, якщо вони є
            if (data.contacts && Array.isArray(data.contacts)) {
                for (const contact of data.contacts) {
                    await client.query(
                        `INSERT INTO clients.contacts (
                            client_id, first_name, last_name, position, 
                            phone, email, is_primary, notes
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                        [
                            newClient.id, contact.first_name, contact.last_name, contact.position,
                            contact.phone, contact.email, contact.is_primary || false, contact.notes
                        ]
                    );
                }
            }

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'CREATE',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'CLIENT',  // Це потрібно додати в ENTITY_TYPES
                entityId: newClient.id,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'clients',
                tableName: 'clients',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return newClient;
        } catch (error) {
            throw error;
        }
    }

    // Оновлення існуючого клієнта
    static async updateClient(client, id, data, userId, req) {
        try {
            // Отримання поточних даних клієнта для аудиту
            const currentClient = await client.query(
                'SELECT * FROM clients.clients WHERE id = $1',
                [id]
            );

            if (currentClient.rows.length === 0) {
                throw new Error('Клієнт не знайдений');
            }

            const oldData = currentClient.rows[0];

            // Перевірка унікальності імені та email
            if (data.name || data.email) {
                const existingClient = await client.query(
                    'SELECT id FROM clients.clients WHERE (name = $1 OR email = $2) AND id != $3',
                    [data.name || oldData.name, data.email || oldData.email, id]
                );

                if (existingClient.rows.length > 0) {
                    throw new Error('Клієнт з такою назвою або email вже існує');
                }
            }

            // Підготовка оновлених даних
            const updateFields = [];
            const updateValues = [];
            let paramIndex = 1;

            const fieldsToUpdate = [
                'name', 'full_name', 'description', 'address', 'contact_person', 
                'phone', 'email', 'wialon_id', 'wialon_username', 'is_active'
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

            // Оновлення клієнта
            const result = await client.query(
                `UPDATE clients.clients 
                 SET ${updateFields.join(', ')}
                 WHERE id = $${paramIndex}
                 RETURNING *`,
                updateValues
            );

            // Оновлення контактів, якщо вони є
            if (data.contacts && Array.isArray(data.contacts)) {
                // Видалення існуючих контактів
                await client.query(
                    'DELETE FROM clients.contacts WHERE client_id = $1',
                    [id]
                );

                // Додавання нових контактів
                for (const contact of data.contacts) {
                    await client.query(
                        `INSERT INTO clients.contacts (
                            client_id, first_name, last_name, position, 
                            phone, email, is_primary, notes
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                        [
                            id, contact.first_name, contact.last_name, contact.position,
                            contact.phone, contact.email, contact.is_primary || false, contact.notes
                        ]
                    );
                }
            }

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'UPDATE',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'CLIENT',  // Це потрібно додати в ENTITY_TYPES
                entityId: id,
                oldValues: oldData,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'clients',
                tableName: 'clients',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return result.rows[0];
        } catch (error) {
            throw error;
        }
    }

    // Видалення клієнта
    static async deleteClient(client, id, userId, req) {
        try {
            // Перевірка чи є об'єкти, пов'язані з клієнтом
            const objectsCheck = await client.query(
                'SELECT id FROM wialon.objects WHERE client_id = $1 LIMIT 1',
                [id]
            );

            if (objectsCheck.rows.length > 0) {
                throw new Error('Неможливо видалити клієнта, який має пов\'язані об\'єкти');
            }

            // Отримання даних клієнта для аудиту
            const clientData = await client.query(
                'SELECT * FROM clients.clients WHERE id = $1',
                [id]
            );

            if (clientData.rows.length === 0) {
                throw new Error('Клієнт не знайдений');
            }

            // Видалення контактів клієнта
            await client.query(
                'DELETE FROM clients.contacts WHERE client_id = $1',
                [id]
            );

            // Видалення документів клієнта
            await client.query(
                'DELETE FROM clients.client_documents WHERE client_id = $1',
                [id]
            );

            // Видалення клієнта
            await client.query(
                'DELETE FROM clients.clients WHERE id = $1',
                [id]
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'DELETE',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'CLIENT',  // Це потрібно додати в ENTITY_TYPES
                entityId: id,
                oldValues: clientData.rows[0],
                ipAddress: req.ip,
                tableSchema: 'clients',
                tableName: 'clients',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return { success: true };
        } catch (error) {
            throw error;
        }
    }

    // Додати документ клієнта
    static async addDocument(client, clientId, documentData, userId, req) {
        try {
            const { document_name, document_type, file_path, file_size, description } = documentData;

            const result = await client.query(
                `INSERT INTO clients.client_documents (
                    client_id, document_name, document_type, file_path, 
                    file_size, description, uploaded_by
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *`,
                [clientId, document_name, document_type, file_path, file_size, description, userId]
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'DOCUMENT_ADD',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'CLIENT_DOCUMENT',  // Це потрібно додати в ENTITY_TYPES
                entityId: result.rows[0].id,
                newValues: documentData,
                ipAddress: req.ip,
                tableSchema: 'clients',
                tableName: 'client_documents',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return result.rows[0];
        } catch (error) {
            throw error;
        }
    }

    // Видалити документ клієнта
    static async deleteDocument(client, documentId, userId, req) {
        try {
            // Отримання даних документа для аудиту
            const documentData = await client.query(
                'SELECT * FROM clients.client_documents WHERE id = $1',
                [documentId]
            );

            if (documentData.rows.length === 0) {
                throw new Error('Документ не знайдений');
            }

            // Видалення документа
            await client.query(
                'DELETE FROM clients.client_documents WHERE id = $1',
                [documentId]
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'DOCUMENT_DELETE',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'CLIENT_DOCUMENT',  // Це потрібно додати в ENTITY_TYPES
                entityId: documentId,
                oldValues: documentData.rows[0],
                ipAddress: req.ip,
                tableSchema: 'clients',
                tableName: 'client_documents',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return { success: true };
        } catch (error) {
            throw error;
        }
    }
}

module.exports = ClientService;