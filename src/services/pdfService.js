const PDFDocument = require('pdfkit');
const CompanyService = require('./company.service');
const path = require('path');

class PDFService {
    // Переклади для PDF
    static translations = {
        uk: {
            invoice: 'РАХУНОК',
            client: 'Клієнт:',
            date: 'Дата:',
            period: 'Період:',
            number: '№',
            service: 'Послуга',
            description: 'Опис',
            quantity: 'Кільк.',
            price: 'Ціна',
            total: 'Сума',
            totalAmount: 'Загальна сума:',
            notes: 'Примітки:',
            generated: 'Рахунок згенеровано',
            address: 'Адреса:',
            phone: 'Телефон:',
            email: 'Email:',
            currency: 'грн',
            months: {
                1: 'Січень', 2: 'Лютий', 3: 'Березень', 4: 'Квітень',
                5: 'Травень', 6: 'Червень', 7: 'Липень', 8: 'Серпень',
                9: 'Вересень', 10: 'Жовтень', 11: 'Листопад', 12: 'Грудень'
            }
        },
        en: {
            invoice: 'INVOICE',
            client: 'Client:',
            date: 'Date:',
            period: 'Period:',
            number: '№',
            service: 'Service',
            description: 'Description',
            quantity: 'Qty.',
            price: 'Price',
            total: 'Total',
            totalAmount: 'Total Amount:',
            notes: 'Notes:',
            generated: 'Invoice generated',
            address: 'Address:',
            phone: 'Phone:',
            email: 'Email:',
            currency: 'UAH',
            months: {
                1: 'January', 2: 'February', 3: 'March', 4: 'April',
                5: 'May', 6: 'June', 7: 'July', 8: 'August',
                9: 'September', 10: 'October', 11: 'November', 12: 'December'
            }
        }
    };

    // Генерація PDF для рахунку з мультимовою підтримкою
    static async generateInvoicePdf(invoice, userLanguage = 'uk') {
        try {
            console.log(`Starting PDF generation with PDFKit for invoice: ${invoice.id}, language: ${userLanguage}`);
            
            // Отримуємо дані компанії
            let companyData;
            try {
                companyData = await CompanyService.getOrganizationDetails();
                console.log('Company data loaded:', companyData);
            } catch (error) {
                console.error('Error loading company data:', error);
                // Використовуємо дефолтні дані якщо не вдалося завантажити
                companyData = {
                    name: 'Your Company Name',
                    address: 'Company Address',
                    phone: 'Company Phone',
                    email: 'company@email.com'
                };
            }

            // Вибираємо переклади
            const t = this.translations[userLanguage] || this.translations.uk;

            // Створюємо PDF документ
            const doc = new PDFDocument({ 
                margin: 50,
                bufferPages: true,
                autoFirstPage: true,
                info: {
                    Title: `Invoice ${invoice.invoice_number}`,
                    Author: companyData.name || 'Company',
                    Creator: 'Invoice System'
                }
            });
            
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
                    // Генеруємо контент PDF з перекладами
                    this.generatePDFContent(doc, invoice, companyData, t, userLanguage);
                    
                    // Завершуємо документ
                    doc.end();
                } catch (error) {
                    console.error('Error in PDF content generation:', error);
                    reject(error);
                }
            });
            
        } catch (error) {
            console.error('Error generating PDF with PDFKit:', error);
            throw error;
        }
    }

    // Генерація контенту PDF з правильним кодуванням та мовою
    static generatePDFContent(doc, invoice, company, t, userLanguage) {
        const pageWidth = doc.page.width - 100;
        
        // Реєструємо та встановлюємо шрифт з підтримкою кирилиці
        try {
            const fontPath = path.join(__dirname, '../fonts/DejaVuSans.ttf');
            doc.registerFont('DejaVu', fontPath);
            doc.font('DejaVu');
            console.log('DejaVu font loaded successfully');
        } catch (error) {
            console.error('Error loading DejaVu font, falling back to Helvetica:', error);
            doc.font('Helvetica');
        }
        
        // Заголовок компанії
        doc.fontSize(20)
           .fillColor('#2c5aa0')
           .text(company.name || 'Company Name', 50, 50, { 
               width: pageWidth * 0.6,
               align: 'left'
           });
           
        // Інформація про компанію
        let yPos = 80;
        doc.fontSize(10)
           .fillColor('black');
           
        if (company.address) {
            doc.text(t.address + ' ' + company.address, 50, yPos);
            yPos += 15;
        }
        if (company.phone) {
            doc.text(t.phone + ' ' + company.phone, 50, yPos);
            yPos += 15;
        }
        if (company.email) {
            doc.text(t.email + ' ' + company.email, 50, yPos);
            yPos += 15;
        }
        
        // Заголовок рахунку (праворуч)
        doc.fontSize(24)
           .fillColor('#2c5aa0')
           .text(t.invoice, 400, 50);
           
        doc.fontSize(18)
           .fillColor('black')
           .text(t.number + ' ' + invoice.invoice_number, 400, 80);

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
            const date = new Date(dateString);
            if (userLanguage === 'en') {
                return date.toLocaleDateString('en-US');
            }
            return date.toLocaleDateString('uk-UA');
        };

        // Ліва колонка - клієнт
        doc.text(t.client, 50, yPos);
        doc.text(invoice.client_name || 'Client Name', 50, yPos + 20);
        
        // Права колонка - деталі рахунку
        doc.text(t.date, 350, yPos);
        doc.text(formatDate(invoice.invoice_date), 350, yPos + 20);
        
        doc.text(t.period, 350, yPos + 40);
        doc.text(t.months[invoice.billing_month] + ' ' + invoice.billing_year, 350, yPos + 60);

        yPos += 100;

        // Таблиця позицій
        if (invoice.items && invoice.items.length > 0) {
            // Заголовок таблиці
            doc.fontSize(10)
               .fillColor('white');
               
            doc.rect(50, yPos, pageWidth, 25)
               .fillColor('#2c5aa0')
               .fill();
               
            // Заголовки колонок з перекладами
            doc.text(t.number, 60, yPos + 8);
            doc.text(t.service, 90, yPos + 8);
            doc.text(t.description, 250, yPos + 8);
            doc.text(t.quantity, 380, yPos + 8);
            doc.text(t.price, 430, yPos + 8);
            doc.text(t.total, 480, yPos + 8);

            yPos += 25;
            
            // Позиції таблиці
            doc.fillColor('black');
            
            invoice.items.forEach((item, index) => {
                // Перевірка чи потрібна нова сторінка
                if (yPos > 700) {
                    doc.addPage();
                    // Встановити шрифт знову на новій сторінці
                    try {
                        const fontPath = path.join(__dirname, '../fonts/DejaVuSans.ttf');
                        doc.registerFont('DejaVu', fontPath);
                        doc.font('DejaVu');
                    } catch (error) {
                        doc.font('Helvetica');
                    }
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
                   .text(item.service_name || (userLanguage === 'en' ? 'Service' : 'Послуга'), 90, yPos + 5)
                   .text(item.description || '', 250, yPos + 5)
                   .text(item.quantity.toString(), 380, yPos + 5)
                   .text(this.formatCurrency(item.unit_price, t.currency), 430, yPos + 5)
                   .text(this.formatCurrency(item.total_price, t.currency), 480, yPos + 5);
                   
                yPos += 20;
            });
        }

        yPos += 30;

        // Загальна сума
        doc.fontSize(16)
           .fillColor('#2c5aa0');
           
        doc.text(t.totalAmount, 350, yPos);
        doc.text(this.formatCurrency(invoice.total_amount, t.currency), 480, yPos);

        // Примітки
        if (invoice.notes) {
            yPos += 50;
            
            doc.fontSize(12)
               .fillColor('black')
               .text(t.notes, 50, yPos);
               
            doc.fontSize(10)
               .text(invoice.notes, 50, yPos + 20, { width: pageWidth });
        }

        // Футер
        const footerY = doc.page.height - 100;
        doc.fontSize(8)
           .fillColor('gray')
           .text(t.generated + ' ' + formatDate(new Date()), 50, footerY)
           .text(company.name || '', 50, footerY + 15);
    }

    // Форматування валюти з підтримкою мови
    static formatCurrency(amount, currency = 'грн') {
        if (amount === null || amount === undefined) return '0.00 ' + currency;
        
        const formattedAmount = parseFloat(amount).toLocaleString('uk-UA', { 
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
        
        return formattedAmount + ' ' + currency;
    }
}

module.exports = PDFService;