const puppeteer = require('puppeteer');
const handlebars = require('handlebars');
const { pool } = require('../database');
const CompanyService = require('./company.service');
const InvoiceTemplatesService = require('./invoice-templates.service');

class PDFService {
    // Генерація PDF для рахунку
    static async generateInvoicePdf(invoice, templateId = null) {
        try {
            // Отримуємо дані компанії
            const companyData = await CompanyService.getOrganizationDetails();
            
            if (!companyData) {
                throw new Error('Дані компанії не знайдено');
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
                throw new Error('Шаблон рахунку не знайдено');
            }
            
            // Підготовка даних для підстановки в шаблон
            const templateData = {
                invoice: invoice,
                company: companyData,
                currentDate: new Date().toLocaleDateString('uk-UA'),
                formattedDate: invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString('uk-UA') : new Date().toLocaleDateString('uk-UA'),
                formattedTotal: parseFloat(invoice.total_amount).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            };
            
            // Компіляція шаблону
            const compiledTemplate = handlebars.compile(template.html_template);
            const html = compiledTemplate(templateData);
            
            // Додавання CSS
            const fullHtml = `
                <html>
                <head>
                    <meta charset="utf-8">
                    <style>
                        ${template.css_styles || ''}
                        
                        body {
                            font-family: 'Arial', sans-serif;
                            padding: 20px;
                        }
                        
                        table {
                            width: 100%;
                            border-collapse: collapse;
                        }
                        
                        th, td {
                            border: 1px solid #ddd;
                            padding: 8px;
                        }
                        
                        th {
                            background-color: #f2f2f2;
                        }
                    </style>
                </head>
                <body>
                    ${html}
                </body>
                </html>
            `;
            
            // Генерація PDF
            const browser = await puppeteer.launch({
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                headless: 'new'
            });
            
            const page = await browser.newPage();
            await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
            
            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' }
            });
            
            await browser.close();
            
            return pdfBuffer;
        } catch (error) {
            console.error('Error generating PDF:', error);
            throw error;
        }
    }
}

module.exports = PDFService;