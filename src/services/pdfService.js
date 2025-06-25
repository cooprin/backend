const PDFDocument = require('pdfkit');
const CompanyService = require('./company.service');
const path = require('path');
const fs = require('fs');

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
            bank: 'Банк:',
            account: 'Рахунок:',
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
            bank: 'Bank:',
            account: 'Account:',
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
                    legal_name: 'Your Company Name',
                    legal_address: 'Company Address',
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
                    Author: companyData.legal_name || companyData.name || 'Company',
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
            if (fs.existsSync(fontPath)) {
                doc.registerFont('DejaVu', fontPath);
                doc.font('DejaVu');
                console.log('DejaVu font loaded successfully');
            } else {
                console.log('DejaVu font not found, using Helvetica');
                doc.font('Helvetica');
            }
        } catch (error) {
            console.error('Error loading DejaVu font, falling back to Helvetica:', error);
            doc.font('Helvetica');
        }
        
        let yPos = 50;
        
        // Додаємо логотип якщо є
        if (company.logo_path) {
            try {
                const logoPath = path.join(process.env.UPLOAD_DIR, company.logo_path);
                if (fs.existsSync(logoPath)) {
                    doc.image(logoPath, 50, yPos, { width: 60, height: 60 });
                    console.log('Logo added successfully');
                }
            } catch (error) {
                console.error('Error loading logo:', error);
            }
        }
        
        // Заголовок компанії (поряд з логотипом)
        doc.fontSize(18)
           .fillColor('#2c5aa0')
           .text(company.legal_name || company.name || 'Company Name', 120, yPos, { 
               width: pageWidth * 0.5,
               align: 'left'
           });
           
        // Заголовок рахунку (праворуч)
        doc.fontSize(22)
           .fillColor('#2c5aa0')
           .text(t.invoice, 400, yPos);
           
        doc.fontSize(16)
           .fillColor('black')
           .text(t.number + ' ' + invoice.invoice_number, 400, yPos + 30);

        yPos += 80;
           
        // Інформація про компанію
        doc.fontSize(9)
           .fillColor('black');
           
        if (company.legal_address || company.address) {
            doc.text(t.address + ' ' + (company.legal_address || company.address), 50, yPos);
            yPos += 12;
        }
        if (company.phone) {
            doc.text(t.phone + ' ' + company.phone, 50, yPos);
            yPos += 12;
        }
        if (company.email) {
            doc.text(t.email + ' ' + company.email, 50, yPos);
            yPos += 12;
        }
        
        // Додаємо банківські реквізити
        if (company.bank_accounts && company.bank_accounts.length > 0) {
            const defaultBank = company.bank_accounts.find(acc => acc.is_default) || company.bank_accounts[0];
            if (defaultBank.bank_name) {
                doc.text(t.bank + ' ' + defaultBank.bank_name, 50, yPos);
                yPos += 12;
            }
            if (defaultBank.account_number) {
                doc.text(t.account + ' ' + defaultBank.account_number, 50, yPos);
                yPos += 12;
            }
            if (defaultBank.iban) {
                doc.text('IBAN: ' + defaultBank.iban, 50, yPos);
                yPos += 12;
            }
        }

        // Лінія розділювач
        yPos = Math.max(yPos + 15, 160);
        doc.moveTo(50, yPos)
           .lineTo(550, yPos)
           .strokeColor('#2c5aa0')
           .lineWidth(2)
           .stroke();

        yPos += 25;

        // Інформація про рахунок
        doc.fontSize(11)
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
        doc.text(invoice.client_name || 'Client Name', 50, yPos + 18);
        
        // Права колонка - деталі рахунку
        doc.text(t.date, 350, yPos);
        doc.text(formatDate(invoice.invoice_date), 350, yPos + 18);
        
        doc.text(t.period, 350, yPos + 36);
        doc.text(t.months[invoice.billing_month] + ' ' + invoice.billing_year, 350, yPos + 54);

        yPos += 90;

        // Таблиця позицій
        if (invoice.items && invoice.items.length > 0) {
            // Заголовок таблиці - ВИПРАВЛЕНО
            const headerHeight = 25;
            
            // Фон заголовка
            doc.rect(50, yPos, pageWidth, headerHeight)
               .fillColor('#2c5aa0')
               .fill();
               
            // Заголовки колонок з перекладами
            doc.fontSize(10)
               .fillColor('white');
               
            // Колонки таблиці з правильним позиціонуванням
            const colPositions = {
                number: 55,
                service: 85,
                description: 240, 
                quantity: 370,
                price: 430,
                total: 490
            };
            
            const headerY = yPos + 8;
            doc.text(t.number, colPositions.number, headerY);
            doc.text(t.service, colPositions.service, headerY);
            doc.text(t.description, colPositions.description, headerY);
            doc.text(t.quantity, colPositions.quantity, headerY);
            doc.text(t.price, colPositions.price, headerY);
            doc.text(t.total, colPositions.total, headerY);

            yPos += headerHeight;
            
            // Позиції таблиці
            doc.fillColor('black');
            
            invoice.items.forEach((item, index) => {
                // Перевірка чи потрібна нова сторінка
                if (yPos > 720) {
                    doc.addPage();
                    // Встановити шрифт знову на новій сторінці
                    try {
                        const fontPath = path.join(__dirname, '../fonts/DejaVuSans.ttf');
                        if (fs.existsSync(fontPath)) {
                            doc.registerFont('DejaVu', fontPath);
                            doc.font('DejaVu');
                        } else {
                            doc.font('Helvetica');
                        }
                    } catch (error) {
                        doc.font('Helvetica');
                    }
                    yPos = 50;
                }
                
                const bgColor = index % 2 === 0 ? '#f9f9f9' : 'white';
                const rowHeight = 25;
                
                if (bgColor === '#f9f9f9') {
                    doc.rect(50, yPos, pageWidth, rowHeight)
                       .fillColor(bgColor)
                       .fill();
                }
                
                doc.fontSize(9)
                   .fillColor('black');
                
                const textY = yPos + 8;
                
                // Текст з обмеженням довжини
                const serviceName = this.truncateText(item.service_name || (userLanguage === 'en' ? 'Service' : 'Послуга'), 20);
                const description = this.truncateText(item.description || '', 25);
                
                doc.text((index + 1).toString(), colPositions.number, textY)
                   .text(serviceName, colPositions.service, textY, { width: 150 })
                   .text(description, colPositions.description, textY, { width: 125 })
                   .text(item.quantity ? item.quantity.toString() : '1', colPositions.quantity, textY)
                   .text(this.formatCurrency(item.unit_price, t.currency), colPositions.price, textY)
                   .text(this.formatCurrency(item.total_price, t.currency), colPositions.total, textY);
                   
                yPos += rowHeight;
            });
        }

        yPos += 25;

        // Загальна сума
        doc.fontSize(14)
           .fillColor('#2c5aa0');
           
        doc.text(t.totalAmount, 350, yPos);
        doc.text(this.formatCurrency(invoice.total_amount, t.currency), 480, yPos);

        // Примітки
        if (invoice.notes) {
            yPos += 40;
            
            doc.fontSize(11)
               .fillColor('black')
               .text(t.notes, 50, yPos);
               
            doc.fontSize(9)
               .text(invoice.notes, 50, yPos + 18, { 
                   width: pageWidth,
                   lineGap: 3
               });
        }

        // Футер
        const footerY = doc.page.height - 80;
        doc.fontSize(7)
           .fillColor('gray')
           .text(t.generated + ' ' + formatDate(new Date()), 50, footerY)
           .text(company.legal_name || company.name || '', 50, footerY + 12);
    }

    // Функція для обрізання тексту
    static truncateText(text, maxLength) {
        if (!text) return '';
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength - 3) + '...';
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