const puppeteer = require('puppeteer');
const handlebars = require('handlebars');
const { pool } = require('../database');
const CompanyService = require('./company.service');
const InvoiceTemplatesService = require('./invoice-templates.service');

class PDFService {
    // Черга для обробки PDF генерації
    static pdfQueue = [];
    static isProcessing = false;
    static maxConcurrent = 1; // Максимум 1 PDF одночасно
    static queueTimeout = 30000; // 30 секунд на один PDF

    // Публічний метод для генерації PDF (з чергою)
    static async generateInvoicePdf(invoice, templateId = null) {
        return new Promise((resolve, reject) => {
            const queueItem = {
                invoice,
                templateId,
                resolve,
                reject,
                timestamp: Date.now()
            };

            this.pdfQueue.push(queueItem);
            console.log(`PDF queued for invoice ${invoice.id}. Queue length: ${this.pdfQueue.length}`);
            
            // Запускаємо обробку черги
            this.processQueue();
        });
    }

    // Обробка черги PDF генерації
    static async processQueue() {
        if (this.isProcessing || this.pdfQueue.length === 0) {
            return;
        }

        this.isProcessing = true;
        
        try {
            const queueItem = this.pdfQueue.shift();
            const { invoice, templateId, resolve, reject, timestamp } = queueItem;

            console.log(`Processing PDF for invoice ${invoice.id}. Remaining in queue: ${this.pdfQueue.length}`);

            // Перевірка timeout
            if (Date.now() - timestamp > this.queueTimeout) {
                console.log(`PDF generation timeout for invoice ${invoice.id}`);
                reject(new Error('PDF generation timeout'));
                return;
            }

            try {
                const result = await this.generateInvoicePdfInternal(invoice, templateId);
                console.log(`PDF generated successfully for invoice ${invoice.id}`);
                resolve(result);
            } catch (error) {
                console.error(`PDF generation failed for invoice ${invoice.id}:`, error.message);
                reject(error);
            }

        } catch (error) {
            console.error('Error in PDF queue processing:', error);
        } finally {
            this.isProcessing = false;
            
            // Пауза між генераціями для зниження навантаження на CPU
            setTimeout(() => {
                this.processQueue();
            }, 2000); // 2 секунди пауза
        }
    }

    // Внутрішній метод генерації PDF
    static async generateInvoicePdfInternal(invoice, templateId = null) {
        let browser = null;
        const startTime = Date.now();
        
        try {
            console.log(`Starting PDF generation for invoice: ${invoice.id}`);
            
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
                console.log('No template found, using fallback template');
                // Створюємо мінімальний шаблон як fallback
                template = {
                    html_template: `
                        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto;">
                            <div style="text-align: center; margin-bottom: 30px; border-bottom: 2px solid #333; padding-bottom: 20px;">
                                <h1 style="color: #333; margin: 0;">РАХУНОК №{{invoice.invoice_number}}</h1>
                                <p style="margin: 10px 0; color: #666;">від {{formattedDate}}</p>
                            </div>
                            
                            <div style="margin-bottom: 20px;">
                                <p><strong>Клієнт:</strong> {{invoice.client_name}}</p>
                                <p><strong>Розрахунковий період:</strong> {{invoice.billing_month}}/{{invoice.billing_year}}</p>
                            </div>
                            
                            {{#if invoice.items}}
                            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                                <thead>
                                    <tr style="background: #f5f5f5;">
                                        <th style="border: 1px solid #ddd; padding: 10px; text-align: left;">Послуга</th>
                                        <th style="border: 1px solid #ddd; padding: 10px; text-align: left;">Опис</th>
                                        <th style="border: 1px solid #ddd; padding: 10px; text-align: center;">Кільк.</th>
                                        <th style="border: 1px solid #ddd; padding: 10px; text-align: right;">Ціна</th>
                                        <th style="border: 1px solid #ddd; padding: 10px; text-align: right;">Сума</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {{#each invoice.items}}
                                    <tr>
                                        <td style="border: 1px solid #ddd; padding: 10px;">{{service_name}}</td>
                                        <td style="border: 1px solid #ddd; padding: 10px;">{{description}}</td>
                                        <td style="border: 1px solid #ddd; padding: 10px; text-align: center;">{{quantity}}</td>
                                        <td style="border: 1px solid #ddd; padding: 10px; text-align: right;">{{formatCurrency unit_price}}</td>
                                        <td style="border: 1px solid #ddd; padding: 10px; text-align: right;">{{formatCurrency total_price}}</td>
                                    </tr>
                                    {{/each}}
                                </tbody>
                            </table>
                            {{/if}}
                            
                            <div style="margin-top: 30px; text-align: right; border-top: 2px solid #333; padding-top: 20px;">
                                <h2 style="color: #333; margin: 0;">Загальна сума: {{formattedTotal}}</h2>
                            </div>
                            
                            {{#if invoice.notes}}
                            <div style="margin-top: 30px; padding: 15px; background: #f9f9f9; border-left: 4px solid #333;">
                                <strong>Примітки:</strong> {{invoice.notes}}
                            </div>
                            {{/if}}
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
            console.log('Compiling template...');
            const compiledTemplate = handlebars.compile(template.html_template);
            const html = compiledTemplate(templateData);
            
            // Додавання CSS і створення повного HTML
            const fullHtml = `
                <!DOCTYPE html>
                <html lang="uk">
                <head>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        @page {
                            size: A4;
                            margin: 2cm;
                        }
                        
                        ${template.css_styles || ''}
                        
                        * {
                            box-sizing: border-box;
                        }
                        
                        body {
                            font-family: 'DejaVu Sans', Arial, sans-serif;
                            padding: 0;
                            margin: 0;
                            font-size: 12px;
                            line-height: 1.4;
                            color: #333;
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
            
            console.log('Launching browser with CPU-optimized settings...');
            
            // Запуск браузера з оптимізацією для CPU
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
                    '--max_old_space_size=1024',
                    '--disable-web-security',
                    '--disable-features=site-per-process',
                    '--js-flags="--max-old-space-size=1024"'
                ],
                headless: 'new',
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
                timeout: 60000,
                protocolTimeout: 60000,
                ignoreDefaultArgs: ['--disable-extensions'],
                dumpio: false,
                pipe: true, // Використовувати pipe замість websocket для стабільності
                defaultViewport: {
                    width: 794,
                    height: 1123
                }
            });
            
            console.log('Browser launched, creating new page...');
            
            const page = await browser.newPage();
            
            // Встановлюємо обмеження ресурсів для сторінки
            await page.setCacheEnabled(false);
            await page.setJavaScriptEnabled(false); // Вимикаємо JS для швидшості
            
            // Встановлюємо контент з timeout
            console.log('Setting page content...');
            await page.setContent(fullHtml, { 
                waitUntil: 'domcontentloaded',
                timeout: 30000 
            });
            
            // Мінімальна затримка для стабільності
            await page.waitForTimeout(500);
            
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
                timeout: 30000,
                preferCSSPageSize: true
            });
            
            const endTime = Date.now();
            console.log(`PDF generated successfully in ${endTime - startTime}ms, closing browser...`);
            
            await browser.close();
            browser = null;
            
            return pdfBuffer;
            
        } catch (error) {
            const endTime = Date.now();
            console.error(`PDF generation failed after ${endTime - startTime}ms:`, {
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

    // Статистика черги
    static getQueueStats() {
        return {
            queueLength: this.pdfQueue.length,
            isProcessing: this.isProcessing,
            maxConcurrent: this.maxConcurrent
        };
    }

    // Очистити чергу (для аварійних ситуацій)
    static clearQueue() {
        console.log(`Clearing PDF queue. ${this.pdfQueue.length} items removed.`);
        this.pdfQueue.forEach(item => {
            item.reject(new Error('Queue cleared'));
        });
        this.pdfQueue = [];
        this.isProcessing = false;
    }
}

module.exports = PDFService;