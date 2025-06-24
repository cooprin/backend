const puppeteer = require('puppeteer');
const handlebars = require('handlebars');
const { pool } = require('../database');
const CompanyService = require('./company.service');
const InvoiceTemplatesService = require('./invoice-templates.service');

class PDFService {
// Генерація PDF для рахунку
static async generateInvoicePdf(invoice, templateId = null) {
    let browser = null;
    try {
        console.log('Starting PDF generation for invoice:', invoice.id);
        
        // Отримуємо дані компанії
        const companyDataRaw = await CompanyService.getOrganizationDetails();
        
        if (!companyDataRaw) {
            throw new Error('Дані компанії не знайдено');
        }
        
        const companyData = {...companyDataRaw};
        
        // Додавання повного URL до логотипу, якщо він є
        if (companyData.logo_path) {
            companyData.logo_path = `${process.env.API_URL}/uploads/${companyData.logo_path}`;
        }
        
        // Отримуємо шаблон
        let template;
        
        if (templateId) {
            template = await InvoiceTemplatesService.getTemplateById(templateId);
        } else if (invoice.template_id) {
            template = await InvoiceTemplatesService.getTemplateById(invoice.template_id);
        } else {
            template = await InvoiceTemplatesService.getDefaultTemplate();
        }
        
        if (!template) {
            // Створюємо мінімальний шаблон як fallback
            template = {
                html_template: `
                    <div style="font-family: Arial, sans-serif; padding: 20px;">
                        <h1>Рахунок №{{invoice.invoice_number}}</h1>
                        <p><strong>Дата:</strong> {{formattedDate}}</p>
                        <p><strong>Клієнт:</strong> {{invoice.client_name}}</p>
                        <p><strong>Період:</strong> {{invoice.billing_month}}/{{invoice.billing_year}}</p>
                        <hr style="margin: 20px 0;">
                        {{#if invoice.items}}
                        <table style="width: 100%; border-collapse: collapse;">
                            <thead>
                                <tr style="background: #f5f5f5;">
                                    <th style="border: 1px solid #ddd; padding: 8px;">Послуга</th>
                                    <th style="border: 1px solid #ddd; padding: 8px;">Опис</th>
                                    <th style="border: 1px solid #ddd; padding: 8px;">Кількість</th>
                                    <th style="border: 1px solid #ddd; padding: 8px;">Ціна</th>
                                    <th style="border: 1px solid #ddd; padding: 8px;">Сума</th>
                                </tr>
                            </thead>
                            <tbody>
                                {{#each invoice.items}}
                                <tr>
                                    <td style="border: 1px solid #ddd; padding: 8px;">{{service_name}}</td>
                                    <td style="border: 1px solid #ddd; padding: 8px;">{{description}}</td>
                                    <td style="border: 1px solid #ddd; padding: 8px; text-align: center;">{{quantity}}</td>
                                    <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">{{formatCurrency unit_price}}</td>
                                    <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">{{formatCurrency total_price}}</td>
                                </tr>
                                {{/each}}
                            </tbody>
                        </table>
                        {{/if}}
                        <div style="margin-top: 20px; text-align: right;">
                            <h3>Загальна сума: {{formattedTotal}}</h3>
                        </div>
                    </div>
                `,
                css_styles: ''
            };
        }

        // Реєструємо хелпери Handlebars
        handlebars.registerHelper('inc', function(value) {
            return parseInt(value) + 1;
        });
        
        handlebars.registerHelper('formatCurrency', function(value) {
            if (value === undefined || value === null) return '0.00';
            return parseFloat(value).toLocaleString('uk-UA', { 
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            }) + ' ₴';
        });
        
        // Підготовка даних для шаблону
        const templateData = {
            invoice: invoice,
            company: companyData,
            currentDate: new Date().toLocaleDateString('uk-UA'),
            formattedDate: invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString('uk-UA') : new Date().toLocaleDateString('uk-UA'),
            formattedTotal: parseFloat(invoice.total_amount).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₴'
        };
        
        // Компіляція шаблону
        const compiledTemplate = handlebars.compile(template.html_template);
        const html = compiledTemplate(templateData);
        
        // Додавання CSS і створення повного HTML
        const fullHtml = `
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    @page {
                        size: A4;
                        margin: 2cm;
                    }
                    ${template.css_styles || ''}
                    
                    body {
                        font-family: 'DejaVu Sans', Arial, sans-serif;
                        padding: 0;
                        margin: 0;
                        font-size: 12px;
                        line-height: 1.4;
                    }
                    
                    table {
                        width: 100%;
                        border-collapse: collapse;
                        margin: 10px 0;
                    }
                    
                    th, td {
                        border: 1px solid #ddd;
                        padding: 8px;
                        text-align: left;
                    }
                    
                    th {
                        background-color: #f2f2f2;
                        font-weight: bold;
                    }
                    
                    .text-right {
                        text-align: right;
                    }
                    
                    .text-center {
                        text-align: center;
                    }
                </style>
            </head>
            <body>
                ${html}
            </body>
            </html>
        `;
        
        console.log('Launching browser with optimized settings...');
        
        // Запуск браузера з оптимізованими налаштуваннями для Docker
        browser = await puppeteer.launch({
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-features=TranslateUI,VizDisplayCompositor',
                '--disable-backgrounding-occluded-windows',
                '--disable-ipc-flooding-protection',
                '--memory-pressure-off',
                '--max_old_space_size=4096'
            ],
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            timeout: 90000,
            protocolTimeout: 90000,
            ignoreDefaultArgs: ['--disable-extensions'],
            dumpio: false
        });
        
        console.log('Browser launched, creating new page...');
        
        const page = await browser.newPage();
        
        // Встановлюємо viewport та інші налаштування
        await page.setViewport({ width: 794, height: 1123 }); // A4 в пікселях
        
        // Встановлюємо контент з timeout
        console.log('Setting page content...');
        await page.setContent(fullHtml, { 
            waitUntil: 'domcontentloaded',
            timeout: 60000 
        });
        
        // Невелика затримка для стабільності
        await page.waitForTimeout(1000);
        
        console.log('Generating PDF...');
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { 
                top: '2cm', 
                right: '2cm', 
                bottom: '2cm', 
                left: '2cm' 
            },
            timeout: 60000
        });
        
        console.log('PDF generated successfully, closing browser...');
        await browser.close();
        browser = null;
        
        return pdfBuffer;
    } catch (error) {
        console.error('Detailed PDF generation error:', {
            message: error.message,
            stack: error.stack,
            invoice_id: invoice?.id,
            template_id: templateId,
            error_type: error.constructor.name
        });
        
        // Закриваємо браузер у випадку помилки
        if (browser) {
            try {
                console.log('Closing browser due to error...');
                await browser.close();
            } catch (closeError) {
                console.error('Error closing browser:', closeError);
            }
        }
        
        throw error;
    }
}
}

module.exports = PDFService;