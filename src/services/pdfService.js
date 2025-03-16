const PDFDocument = require('pdfkit');

class PDFService {
    // Генерація PDF для рахунку
    static async generateInvoicePdf(invoice) {
        return new Promise((resolve, reject) => {
            try {
                // Створюємо новий PDF документ
                const doc = new PDFDocument({ margin: 50 });
                
                // Буфер для збереження PDF
                const buffers = [];
                doc.on('data', buffers.push.bind(buffers));
                doc.on('end', () => {
                    const pdfData = Buffer.concat(buffers);
                    resolve(pdfData);
                });
                
                // Додаємо заголовок
                doc.fontSize(25).text('РАХУНОК', { align: 'center' });
                doc.moveDown();
                
                // Додаємо інформацію про рахунок
                doc.fontSize(14);
                doc.text(`Номер рахунку: ${invoice.invoice_number}`);
                doc.text(`Дата: ${new Date(invoice.invoice_date).toLocaleDateString('uk-UA')}`);
                doc.text(`Період: ${invoice.billing_month}/${invoice.billing_year}`);
                doc.moveDown();
                
                // Додаємо інформацію про клієнта
                doc.text(`Клієнт: ${invoice.client_name}`);
                if (invoice.client_address) {
                    doc.text(`Адреса: ${invoice.client_address}`);
                }
                doc.moveDown();
                
                // Таблиця з послугами
                doc.fontSize(12);
                const tableTop = doc.y;
                const tableHeaders = ['Послуга', 'Опис', 'Кількість', 'Ціна', 'Сума'];
                const tableWidths = [150, 180, 50, 70, 70];
                
                // Заголовки таблиці
                let currentX = 50;
                tableHeaders.forEach((header, i) => {
                    doc.text(header, currentX, tableTop, { width: tableWidths[i], align: 'left' });
                    currentX += tableWidths[i];
                });
                
                doc.moveDown();
                const items = Array.isArray(invoice.items) ? invoice.items : JSON.parse(invoice.items || '[]');
                
                // Рядки таблиці
                let tableRowY = doc.y;
                items.forEach(item => {
                    currentX = 50;
                    doc.text(item.service_name || '', currentX, tableRowY, { width: tableWidths[0], align: 'left' });
                    currentX += tableWidths[0];
                    doc.text(item.description || '', currentX, tableRowY, { width: tableWidths[1], align: 'left' });
                    currentX += tableWidths[1];
                    doc.text(item.quantity?.toString() || '1', currentX, tableRowY, { width: tableWidths[2], align: 'center' });
                    currentX += tableWidths[2];
                    doc.text(item.unit_price?.toFixed(2) || '0.00', currentX, tableRowY, { width: tableWidths[3], align: 'right' });
                    currentX += tableWidths[3];
                    doc.text(item.total_price?.toFixed(2) || '0.00', currentX, tableRowY, { width: tableWidths[4], align: 'right' });
                    
                    // Переходимо до наступного рядка
                    tableRowY = doc.y + 20;
                    doc.moveDown();
                });
                
                doc.moveDown();
                // Загальна сума
                doc.fontSize(14);
                doc.text(`Загальна сума: ${invoice.total_amount.toFixed(2)} грн`, { align: 'right' });
                
                // Статус
                doc.moveDown();
                const statusText = {
                    'issued': 'Виставлено',
                    'paid': 'Оплачено',
                    'cancelled': 'Скасовано'
                };
                doc.text(`Статус: ${statusText[invoice.status] || invoice.status}`, { align: 'right' });
                
                // Дата оплати, якщо є
                if (invoice.payment_date) {
                    doc.text(`Дата оплати: ${new Date(invoice.payment_date).toLocaleDateString('uk-UA')}`, { align: 'right' });
                }
                
                // Примітки, якщо є
                if (invoice.notes) {
                    doc.moveDown();
                    doc.fontSize(12);
                    doc.text('Примітки:', { underline: true });
                    doc.text(invoice.notes);
                }
                
                // Завершуємо документ
                doc.end();
            } catch (error) {
                reject(error);
            }
        });
    }
}

module.exports = PDFService;