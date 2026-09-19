const nodemailer = require('nodemailer');
const { getRow, getAll } = require('../database/db');

class EmailService {
  /**
   * Get dynamic Transporter using Database SMTP Config
   */
  static async getTransporter() {
    const smtp = await getRow('SELECT * FROM smtp_config WHERE id = 1;');
    if (!smtp || !smtp.host) {
      return null;
    }

    const secure = smtp.encryption === 'SSL/TLS';
    const requireTLS = smtp.encryption === 'STARTTLS';

    return {
      transporter: nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: secure,
        requireTLS: requireTLS,
        auth: (smtp.username && smtp.password) ? {
          user: smtp.username,
          pass: smtp.password
        } : undefined,
        tls: {
          rejectUnauthorized: false // Allow self-signed VPS certificates if needed
        }
      }),
      fromEmail: smtp.from_email || smtp.username || 'noreply@vpsmanager.local',
      fromName: smtp.from_name || 'VPS Cloud Manager'
    };
  }

  /**
   * Replace template tags like {{name}}, {{app_name}}, etc.
   */
  static renderTemplate(templateHtml, variables = {}) {
    let output = templateHtml;
    for (const [key, val] of Object.entries(variables)) {
      const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
      output = output.replace(regex, val || '');
    }
    return output;
  }

  /**
   * Send Email using named Template slug
   */
  static async sendTemplatedEmail(slug, toEmail, variables = {}) {
    try {
      const transporterObj = await this.getTransporter();
      if (!transporterObj) {
        console.log(`[Email Notice] SMTP not configured. Skipped sending email '${slug}' to ${toEmail}.`);
        return false;
      }

      const template = await getRow('SELECT * FROM email_templates WHERE slug = ?;', [slug]);
      if (!template) {
        throw new Error(`Email template '${slug}' not found`);
      }

      const appName = variables.app_name || process.env.APP_NAME || 'VPS Cloud Manager';
      const vars = { ...variables, app_name: appName };

      const subject = this.renderTemplate(template.subject, vars);
      const html = this.renderTemplate(template.body_html, vars);

      const info = await transporterObj.transporter.sendMail({
        from: `"${transporterObj.fromName}" <${transporterObj.fromEmail}>`,
        to: toEmail,
        subject: subject,
        html: html
      });

      console.log(`Email '${slug}' sent to ${toEmail}. MessageId: ${info.messageId}`);
      return true;
    } catch (err) {
      console.error(`Error sending email '${slug}':`, err);
      return false;
    }
  }

  /**
   * Send Test Email
   */
  static async sendTestEmail(toEmail) {
    const transporterObj = await this.getTransporter();
    if (!transporterObj) {
      throw new Error('SMTP Configuration is incomplete. Host is missing.');
    }

    const info = await transporterObj.transporter.sendMail({
      from: `"${transporterObj.fromName}" <${transporterObj.fromEmail}>`,
      to: toEmail,
      subject: `[Test Email] ${transporterObj.fromName} Verification`,
      html: `<div style="font-family: sans-serif; padding: 20px;"><h2>SMTP Test Successful!</h2><p>Your SMTP credentials for <strong>${transporterObj.fromName}</strong> are working properly.</p></div>`
    });

    return info;
  }
}

module.exports = EmailService;
