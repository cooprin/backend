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
           
        // Інформація про компанію з переносом тексту
        doc.fontSize(9)
           .fillColor('black');
           
        if (company.legal_address || company.address) {
            const addressText = t.address + ' ' + (company.legal_address || company.address);
            doc.text(addressText, 50, yPos, { width: 300, align: 'left' });
            yPos += doc.heightOfString(addressText, { width: 300 }) + 5;
        }
        if (company.phone) {
            const phoneText = t.phone + ' ' + company.phone;
            doc.text(phoneText, 50, yPos, { width: 300, align: 'left' });
            yPos += doc.heightOfString(phoneText, { width: 300 }) + 5;
        }
        if (company.email) {
            const emailText = t.email + ' ' + company.email;
            doc.text(emailText, 50, yPos, { width: 300, align: 'left' });
            yPos += doc.heightOfString(emailText, { width: 300 }) + 5;
        }
        
        // Додаємо банківські реквізити з переносом
        if (company.bank_accounts && company.bank_accounts.length > 0) {
            const defaultBank = company.bank_accounts.find(acc => acc.is_default) || company.bank_accounts[0];
            if (defaultBank.bank_name) {
                const bankText = t.bank + ' ' + defaultBank.bank_name;
                doc.text(bankText, 50, yPos, { width: 300, align: 'left' });
                yPos += doc.heightOfString(bankText, { width: 300 }) + 5;
            }
            if (defaultBank.account_number) {
                const accountText = t.account + ' ' + defaultBank.account_number;
                doc.text(accountText, 50, yPos, { width: 300, align: 'left' });
                yPos += doc.heightOfString(accountText, { width: 300 }) + 5;
            }
            if (defaultBank.iban) {
                const ibanText = 'IBAN: ' + defaultBank.iban;
                doc.text(ibanText, 50, yPos, { width: 300, align: 'left' });
                yPos += doc.heightOfString(ibanText, { width: 300 }) + 5;
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

        // Ліва колонка - клієнт з переносом
        const clientText = t.client;
        const clientName = invoice.client_name || 'Client Name';
        
        doc.text(clientText, 50, yPos);
        doc.text(clientName, 50, yPos + 18, { width: 250, align: 'left' });
        
        // Права колонка - деталі рахунку
        doc.text(t.date, 350, yPos);
        doc.text(formatDate(invoice.invoice_date), 350, yPos + 18);
        
        doc.text(t.period, 350, yPos + 36);
        doc.text(t.months[invoice.billing_month] + ' ' + invoice.billing_year, 350, yPos + 54);

        // Враховуємо висоту імені клієнта
        const clientNameHeight = doc.heightOfString(clientName, { width: 250 });
        yPos += Math.max(90, clientNameHeight + 60);

        // Таблиця позицій
        if (invoice.items && invoice.items.length > 0) {
            // Заголовок таблиці
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
                price: 420,
                total: 480
            };
            
            // Ширина колонок
            const colWidths = {
                number: 25,
                service: 150,
                description: 125,
                quantity: 45,
                price: 55,
                total: 65
            };
            
            const headerY = yPos + 8;
            doc.text(t.number, colPositions.number, headerY, { width: colWidths.number, align: 'center' });
            doc.text(t.service, colPositions.service, headerY, { width: colWidths.service, align: 'left' });
            doc.text(t.description, colPositions.description, headerY, { width: colWidths.description, align: 'left' });
            doc.text(t.quantity, colPositions.quantity, headerY, { width: colWidths.quantity, align: 'center' });
            doc.text(t.price, colPositions.price, headerY, { width: colWidths.price, align: 'right' });
            doc.text(t.total, colPositions.total, headerY, { width: colWidths.total, align: 'right' });

            yPos += headerHeight;
            
            // Позиції таблиці
            doc.fillColor('black');
            
            invoice.items.forEach((item, index) => {
                // Перевірка чи потрібна нова сторінка
                if (yPos > 650) { // Зменшив поріг для кращого розміщення
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
                
                // Підготовка тексту для всіх колонок
                const serviceName = item.service_name || (userLanguage === 'en' ? 'Service' : 'Послуга');
                const description = item.description || '';
                const quantity = item.quantity ? item.quantity.toString() : '1';
                const unitPrice = this.formatCurrency(item.unit_price, t.currency);
                const totalPrice = this.formatCurrency(item.total_price, t.currency);
                const rowNumber = (index + 1).toString();

                // Розраховуємо потрібну висоту для кожної колонки
                const serviceHeight = doc.heightOfString(serviceName, { width: colWidths.service });
                const descHeight = doc.heightOfString(description, { width: colWidths.description });
                const qtyHeight = doc.heightOfString(quantity, { width: colWidths.quantity });
                const priceHeight = doc.heightOfString(unitPrice, { width: colWidths.price });
                const totalHeight = doc.heightOfString(totalPrice, { width: colWidths.total });
                const numberHeight = doc.heightOfString(rowNumber, { width: colWidths.number });

                // Беремо максимальну висоту + відступи
                const actualRowHeight = Math.max(25, serviceHeight + 10, descHeight + 10, qtyHeight + 10, priceHeight + 10, totalHeight + 10, numberHeight + 10);
                
                const bgColor = index % 2 === 0 ? '#f9f9f9' : 'white';
                
                // Фон рядка з правильною висотою
                if (bgColor === '#f9f9f9') {
                    doc.rect(50, yPos, pageWidth, actualRowHeight)
                       .fillColor(bgColor)
                       .fill();
                }
                
                doc.fontSize(9)
                   .fillColor('black');

                const textY = yPos + 5;
                
                // Текст з переносом для всіх колонок
                doc.text(rowNumber, colPositions.number, textY, { 
                    width: colWidths.number, 
                    align: 'center' 
                });
                
                doc.text(serviceName, colPositions.service, textY, { 
                    width: colWidths.service, 
                    align: 'left'
                });
                
                doc.text(description, colPositions.description, textY, { 
                    width: colWidths.description, 
                    align: 'left'
                });
                
                doc.text(quantity, colPositions.quantity, textY, { 
                    width: colWidths.quantity, 
                    align: 'center'
                });
                
                doc.text(unitPrice, colPositions.price, textY, { 
                    width: colWidths.price, 
                    align: 'right'
                });
                
                doc.text(totalPrice, colPositions.total, textY, { 
                    width: colWidths.total, 
                    align: 'right'
                });
                   
                yPos += actualRowHeight;
            });
        }

        yPos += 25;

        // Загальна сума
        doc.fontSize(14)
           .fillColor('#2c5aa0');
           
        const totalAmountText = t.totalAmount;
        const totalAmountValue = this.formatCurrency(invoice.total_amount, t.currency);
        
        doc.text(totalAmountText, 350, yPos, { width: 120, align: 'left' });
        doc.text(totalAmountValue, 480, yPos, { width: 65, align: 'right' });

        // Примітки з переносом
        if (invoice.notes) {
            yPos += 40;
            
            doc.fontSize(11)
               .fillColor('black')
               .text(t.notes, 50, yPos);
               
            doc.fontSize(9)
               .text(invoice.notes, 50, yPos + 18, { 
                   width: pageWidth,
                   align: 'left',
                   lineGap: 3
               });
        }

        // Футер з переносом тексту
        const footerY = doc.page.height - 80;
        const generatedText = t.generated + ' ' + formatDate(new Date());
        const companyNameText = company.legal_name || company.name || '';
        
        doc.fontSize(7)
           .fillColor('gray')
           .text(generatedText, 50, footerY, { width: pageWidth, align: 'left' })
           .text(companyNameText, 50, footerY + 12, { width: pageWidth, align: 'left' });
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