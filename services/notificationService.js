const nodemailer = require('nodemailer');
const axios = require('axios');
const db = require('../config/db');

class NotificationService {
  constructor() {
    this.placeholderMap = {
      '{{name}}': 'employee_name',
      '{{username}}': 'employee_name',
      '{{code}}': 'employee_code',
      '{{date}}': 'date',
      '{{time}}': 'time',
      '{{in_time}}': 'in_time',
      '{{out_time}}': 'out_time',
      '{{total_hours}}': 'total_hours',
      '{{organization}}': 'organization_name',
      '{{organization_name}}': 'organization_name',
      '{{status}}': 'status',
      '{{employee_name}}': 'employee_name',
      '{{employee_code}}': 'employee_code',
      '{{department}}': 'department',
      '{{position}}': 'position',
      '{{email}}': 'email',
      '{{phone}}': 'phone_number',
      '{{phone_number}}': 'phone_number',
      '{{employee_type}}': 'employee_type',
      '{{registration_date}}': 'registration_date',
      '{{registration_time}}': 'registration_time'
    };
  }

  replacePlaceholders(template, data) {
    if (!template) return '';
    
    const placeholders = {};
    Object.keys(this.placeholderMap).forEach(key => {
      const dataKey = this.placeholderMap[key];
      placeholders[key] = String(data[dataKey] || '');
    });
    
    let result = template;
    const sortedKeys = Object.keys(placeholders).sort((a, b) => b.length - a.length);
    
    sortedKeys.forEach(key => {
      const escapedKey = key.replace(/[{}]/g, '\\$&');
      const regex = new RegExp(escapedKey, 'gi');
      result = result.replace(regex, placeholders[key]);
      
      const keyWithoutBraces = key.replace(/[{}]/g, '').trim();
      const flexibleRegex = new RegExp(`\\{\\{\\s*${keyWithoutBraces.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'gi');
      result = result.replace(flexibleRegex, placeholders[key]);
    });
    
    return result;
  }

  async getEmailConfig(templateType, eventType) {
    // Only find by event_type (no fallback)
    let query = `SELECT smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, 
                        from_email, from_name, subject, email_body
                 FROM email_config 
                 WHERE event_type = $1 AND is_active = true
                 ORDER BY updated_at DESC
                 LIMIT 1`;
    const { rows } = await db.query(query, [eventType]);
    
    if (rows.length === 0) {
      console.error(`[EMAIL] No email config found for eventType: ${eventType}`);
    } else {
      console.log(`[EMAIL] Found email config for eventType: ${eventType}`);
    }
    
    return rows[0] || null;
  }

  async createTransporter(config) {
    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: config.smtp_port,
      secure: config.smtp_secure,
      auth: {
        user: config.smtp_user,
        pass: config.smtp_password
      }
    });
    await transporter.verify();
    return transporter;
  }

  convertToHtml(text) {
    if (!text || text.includes('<') || text.includes('&lt;')) return text;
    return text
      .replace(/\n/g, '<br>')
      .replace(/\r/g, '')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>');
  }

  async getEmployeeEmail(employeeData) {
    if (employeeData.email) return employeeData.email;
    if (!employeeData.employee_id) return null;
    
    const { rows } = await db.query(
      'SELECT email FROM employee_details WHERE employee_id = $1',
      [employeeData.employee_id]
    );
    return rows[0]?.email || null;
  }

  async sendEmail(templateType, employeeData, eventType) {
    try {
      console.log(`[EMAIL] Attempting to send email - templateType: ${templateType}, eventType: ${eventType}`);
      const config = await this.getEmailConfig(templateType, eventType);
      if (!config) {
        console.error(`[EMAIL] No email configuration found for templateType: ${templateType}, eventType: ${eventType}`);
        return { success: false, message: `No email configuration found for ${eventType}` };
      }

      console.log(`[EMAIL] Email config found, creating transporter...`);
      const transporter = await this.createTransporter(config);
      const subject = this.replacePlaceholders(config.subject || '', employeeData);
      let htmlBody = this.replacePlaceholders(config.email_body || '', employeeData);
      htmlBody = this.convertToHtml(htmlBody);

      const toEmail = await this.getEmployeeEmail(employeeData);
      if (!toEmail) {
        console.error(`[EMAIL] Employee email not found for employee_id: ${employeeData.employee_id}`);
        return { success: false, message: 'Employee email not found' };
      }

      console.log(`[EMAIL] Sending email to: ${toEmail}, subject: ${subject.substring(0, 50)}...`);
      const info = await transporter.sendMail({
        from: `"${config.from_name || 'Attendance System'}" <${config.from_email}>`,
        to: toEmail,
        subject: subject,
        html: htmlBody,
        text: htmlBody.replace(/<[^>]*>/g, '')
      });

      console.log(`[EMAIL] ✅ Email sent successfully! MessageId: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error(`[EMAIL] ❌ Error sending notification:`, error.message);
      console.error(`[EMAIL] Full error:`, error);
      return { success: false, message: error.message };
    }
  }

  async sendWhatsApp(templateType, employeeData) {
    try {
      const { rows } = await db.query(
        `SELECT api_url, api_key, message_body
         FROM whatsapp_config 
         WHERE template_type = $1 AND is_active = true
         ORDER BY updated_at DESC
         LIMIT 1`,
        [templateType]
      );

      if (rows.length === 0) {
        return { success: false, message: 'No WhatsApp configuration found' };
      }

      const config = rows[0];
      const { rows: empRows } = await db.query(
        'SELECT phone_number FROM employee_details WHERE employee_id = $1',
        [employeeData.employee_id]
      );

      if (!empRows[0]?.phone_number) {
        return { success: false, message: 'Employee phone number not found' };
      }

      const toPhone = empRows[0].phone_number.replace(/\D/g, '');
      const messageBody = this.replacePlaceholders(config.message_body || '', employeeData);

      const response = await axios.post(config.api_url, {
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'text',
        text: { body: messageBody }
      }, {
        headers: {
          'Authorization': `Bearer ${config.api_key}`,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, messageId: response.data?.messages?.[0]?.id };
    } catch (error) {
      console.error(`[WHATSAPP] Error:`, error.response?.data || error.message);
      return { success: false, message: error.response?.data?.error?.message || error.message };
    }
  }

  getNotificationConfig(status) {
    const configs = {
      'checked_in': { templateType: 'check_in_notification', eventType: 'check_in_notification' },
      'checked_out': { templateType: 'check_out_notification', eventType: 'check_out_notification' }
    };
    return configs[status] || null;
  }

  async triggerAttendanceNotifications(status, employeeData) {
    const config = this.getNotificationConfig(status);
    if (!config) {
      console.error(`[NOTIFICATION] No notification config found for status: ${status}`);
      return;
    }

    console.log(`[NOTIFICATION] Triggering notifications for status: ${status}, templateType: ${config.templateType}, eventType: ${config.eventType}`);
    
    this.sendEmail(config.templateType, employeeData, config.eventType)
      .then(result => {
        if (result.success) {
          console.log(`[NOTIFICATION] ✅ Email sent successfully: ${result.messageId}`);
        } else {
          console.error(`[NOTIFICATION] ❌ Email failed: ${result.message}`);
        }
      })
      .catch(err => console.error(`[NOTIFICATION] Email error:`, err));

    this.sendWhatsApp(config.templateType, employeeData)
      .then(result => {
        if (result.success) {
          console.log(`[NOTIFICATION] ✅ WhatsApp sent successfully: ${result.messageId}`);
        } else {
          console.error(`[NOTIFICATION] ❌ WhatsApp failed: ${result.message}`);
        }
      })
      .catch(err => console.error(`[NOTIFICATION] WhatsApp error:`, err));
  }

  async triggerEmployeeRegistrationNotification(employeeData) {
    return this.sendEmail('employee_registered', employeeData, 'employee_registered')
      .catch(err => {
        console.error(`[NOTIFICATION] Registration email error:`, err);
        return { success: false, message: err.message };
      });
  }
}

const notificationService = new NotificationService();

module.exports = {
  sendEmailNotification: (templateType, employeeData, eventType) => 
    notificationService.sendEmail(templateType, employeeData, eventType),
  sendWhatsAppNotification: (templateType, employeeData) => 
    notificationService.sendWhatsApp(templateType, employeeData),
  triggerAttendanceNotifications: (status, employeeData) => 
    notificationService.triggerAttendanceNotifications(status, employeeData),
  triggerEmployeeRegistrationNotification: (employeeData) => 
    notificationService.triggerEmployeeRegistrationNotification(employeeData),
  replacePlaceholders: (template, data) => 
    notificationService.replacePlaceholders(template, data)
};
