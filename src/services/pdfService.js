const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const CompanyService = require('./company.service');
const InvoiceTemplatesService = require('./invoice-templates.service');

class PDFService {
    // Генерація PDF для рахунку з PDFKit
    static async generateInvoicePdf(invoice, templateId = null) {
        try {
            console.log('Starting PDF generation with PDFKit for invoice:', invoice.id);
            
            // Отримуємо дані компанії
            const companyData = await CompanyService.getOrganizationDetails();
            
            if (!companyData) {
                throw new Error('Дані компанії не знайдено');
            }

            // Створюємо PDF документ
            const doc = new PDFDocument({ margin: 50 });
            const chunks = [];
            
            // Збираємо PDF у буфер
            doc.on('data', chunk => chunks.push(chunk));
            
            return new Promise((resolve, reject) => {
                doc.on('end', () => {
                    const pdfBuffer = Buffer.concat(chunks);
                    console.log('PDF generated successfully with PDFKit');
                    resolve(pdfBuffer);
                });

                doc.on('error', reject);

                try {
                    // Генеруємо контент PDF
                    this.generatePDFContent(doc, invoice, companyData);
                    
                    // Завершуємо документ
                    doc.end();
                } catch (error) {
                    reject(error);
                }
            });
            
        } catch (error) {
            console.error('Error generating PDF with PDFKit:', error);
            throw error;
        }
    }

    // Генерація контенту PDF
    static generatePDFContent(doc, invoice, company) {
        const pageWidth = doc.page.width - 100; // Враховуємо margins
        
        // Заголовок компанії
        doc.fontSize(20)
           .fillColor('#2c5aa0')
           .text(company.name || 'Назва компанії', 50, 50);
           
        // Інформація про компанію
        let yPos = 80;
        doc.fontSize(10)
           .fillColor('black');
           
        if (company.address) {
            doc.text(`Адреса: ${company.address}`, 50, yPos);
            yPos += 15;
        }
        if (company.phone) {
            doc.text(`Телефон: ${company.phone}`, 50, yPos);
            yPos += 15;
        }
        if (company.email) {
            doc.text(`Email: ${company.email}`, 50, yPos);
            yPos += 15;
        }
        
        // Заголовок рахунку
        doc.fontSize(24)
           .fillColor('#2c5aa0')
           .text('РАХУНОК', 400, 50);
           
        doc.fontSize(18)
           .fillColor('black')
           .text(`№ ${invoice.invoice_number}`, 400, 80);

        // Лінія розділювач
        yPos = Math.max(yPos + 20, 120);
        doc.moveTo(50, yPos)
           .lineTo(550, yPos)
           .strokeColor('#2c5aa0')
           .lineWidth(2)
           .stroke();

        yPos += 30;

        // Інформація про рахунок
        doc.fontSize(12)
           .fillColor('black');
           
        const formatDate = (dateString) => {
            return new Date(dateString).toLocaleDateString('uk-UA');
        };

        const monthNames = {
            1: 'Січень', 2: 'Лютий', 3: 'Березень', 4: 'Квітень',
            5: 'Травень', 6: 'Червень', 7: 'Липень', 8: 'Серпень',
            9: 'Вересень', 10: 'Жовтень', 11: 'Листопад', 12: 'Грудень'
        };

        // Ліва колонка - клієнт
        doc.text('Клієнт:', 50, yPos);
        doc.text(invoice.client_name, 50, yPos + 20);
        
        // Права колонка - деталі рахунку
        doc.text('Дата:', 350, yPos);
        doc.text(formatDate(invoice.invoice_date), 350, yPos + 20);
        
        doc.text('Період:', 350, yPos + 40);
        doc.text(`${monthNames[invoice.billing_month]} ${invoice.billing_year}`, 350, yPos + 60);

        yPos += 100;

        // Таблиця позицій
        if (invoice.items && invoice.items.length > 0) {
            // Заголовок таблиці
            doc.fontSize(10)
               .fillColor('white');
               
            doc.rect(50, yPos, pageWidth, 25)
               .fillColor('#2c5aa0')
               .fill();
               
            doc.text('№', 60, yPos + 8);
            doc.text('Послуга', 90, yPos + 8);
            doc.text('Опис', 250, yPos + 8);
            doc.text('Кільк.', 380, yPos + 8);
            doc.text('Ціна', 430, yPos + 8);
            doc.text('Сума', 480, yPos + 8);

            yPos += 25;
            
            // Позиції таблиці
            doc.fillColor('black');
            
            invoice.items.forEach((item, index) => {
                // Перевірка чи потрібна нова сторінка
                if (yPos > 700) {
                    doc.addPage();
                    yPos = 50;
                }
                
                const bgColor = index % 2 === 0 ? '#f9f9f9' : 'white';
                
                if (bgColor === '#f9f9f9') {
                    doc.rect(50, yPos, pageWidth, 20)
                       .fillColor(bgColor)
                       .fill();
                }
                
                doc.fillColor('black')
                   .text((index + 1).toString(), 60, yPos + 5)
                   .text(item.service_name || 'Послуга', 90, yPos + 5)
                   .text(item.description || '', 250, yPos + 5)
                   .text(item.quantity.toString(), 380, yPos + 5)
                   .text(this.formatCurrency(item.unit_price), 430, yPos + 5)
                   .text(this.formatCurrency(item.total_price), 480, yPos + 5);
                   
                yPos += 20;
            });
        }

        yPos += 30;

        // Загальна сума
        doc.fontSize(16)
           .fillColor('#2c5aa0');
           
        doc.text('Загальна сума:', 350, yPos);
        doc.text(this.formatCurrency(invoice.total_amount), 480, yPos);

        // Примітки
        if (invoice.notes) {
            yPos += 50;
            
            doc.fontSize(12)
               .fillColor('black')
               .text('Примітки:', 50, yPos);
               
            doc.fontSize(10)
               .text(invoice.notes, 50, yPos + 20, { width: pageWidth });
        }

        // Футер
        const footerY = doc.page.height - 100;
        doc.fontSize(8)
           .fillColor('gray')
           .text(`Рахунок згенеровано ${new Date().toLocaleDateString('uk-UA')}`, 50, footerY)
           .text(company.name || '', 50, footerY + 15);
    }

    // Форматування валюти
    static formatCurrency(amount) {
        if (amount === null || amount === undefined) return '0.00 ₴';
        return parseFloat(amount).toLocaleString('uk-UA', { 
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }) + ' ₴';
    }
}

module.exports = PDFService;