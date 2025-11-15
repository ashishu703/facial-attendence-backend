const nodemailer = require('nodemailer');
const axios = require('axios');
const db = require('../config/db');

// Replace placeholders in template
function replacePlaceholders(template, data) {
  if (!template) return '';
  
  const placeholders = {
    '{{name}}': data.employee_name || '',
    '{{username}}': data.employee_name || '', // Alias for name
    '{{code}}': data.employee_code || '',
    '{{date}}': data.date || '',
    '{{time}}': data.time || '',
    '{{in_time}}': data.in_time || '',
    '{{out_time}}': data.out_time || '',
    '{{total_hours}}': String(data.total_hours || ''),
    '{{organization}}': data.organization_name || '',
    '{{organization_name}}': data.organization_name || '', // Explicit organization_name
    '{{status}}': data.status || '',
    // Employee registration variables
    '{{employee_name}}': data.employee_name || '',
    '{{employee_code}}': data.employee_code || '',
    '{{department}}': data.department || '',
    '{{position}}': data.position || '',
    '{{email}}': data.email || '',
    '{{phone}}': data.phone_number || '',
    '{{phone_number}}': data.phone_number || '',
    '{{employee_type}}': data.employee_type || '',
    '{{organization}}': data.organization_name || '', // Alias for organization_name
    '{{registration_date}}': data.registration_date || '',
    '{{registration_time}}': data.registration_time || '',
  };
  
  // Replace placeholders - handle both {{var}} and {{ var }} formats
  let result = template;
  
  // Sort placeholders by length (longest first) to avoid partial replacements
  const sortedKeys = Object.keys(placeholders).sort((a, b) => b.length - a.length);
  
  // First pass: replace exact matches (longest first)
  sortedKeys.forEach(key => {
    const escapedKey = key.replace(/[{}]/g, '\\$&');
    const regex = new RegExp(escapedKey, 'gi');
    result = result.replace(regex, placeholders[key]);
  });
  
  // Second pass: handle placeholders with spaces like {{ organization_name }}
  sortedKeys.forEach(key => {
    const keyWithoutBraces = key.replace(/[{}]/g, '').trim();
    const spacedVariations = [
      `{{ ${keyWithoutBraces} }}`,
      `{{${keyWithoutBraces} }}`,
      `{{ ${keyWithoutBraces}}}`,
    ];
    
    spacedVariations.forEach(spacedKey => {
      const regex = new RegExp(spacedKey.replace(/[{}]/g, '\\$&'), 'gi');
      result = result.replace(regex, placeholders[key]);
    });
  });
  
  // Third pass: catch any remaining variations with different spacing
  sortedKeys.forEach(key => {
    const keyWithoutBraces = key.replace(/[{}]/g, '').trim();
    // Match {{var}}, {{ var }}, {{var }}, {{ var}}, etc.
    const flexibleRegex = new RegExp(`\\{\\{\\s*${keyWithoutBraces.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'gi');
    if (flexibleRegex.test(result)) {
      result = result.replace(flexibleRegex, placeholders[key]);
    }
  });
  
  return result;
}

// Send email notification
async function sendEmailNotification(templateType, employeeData, eventType = null) {
  try {
    // Get email config for this template type and event type (if provided)
    let query, params;
    if (eventType) {
      // Priority: event_type match first, then template_type match
      query = `SELECT smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, 
                      from_email, from_name, subject, email_body
               FROM email_config 
               WHERE (event_type = $2 OR template_type = $1) AND is_active = true
               ORDER BY CASE WHEN event_type = $2 THEN 0 ELSE 1 END, updated_at DESC
               LIMIT 1`;
      params = [templateType, eventType];
    } else {
      query = `SELECT smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, 
                      from_email, from_name, subject, email_body
               FROM email_config 
               WHERE template_type = $1 AND is_active = true
               ORDER BY updated_at DESC
               LIMIT 1`;
      params = [templateType];
    }
    
    const { rows } = await db.query(query, params);

    if (rows.length === 0) {
      console.log(`[EMAIL] ❌ No active email config found`);
      console.log(`[EMAIL] Search params: templateType='${templateType}', eventType='${eventType}'`);
      console.log(`[EMAIL] 💡 Tip: Create an email config with event_type = '${eventType || templateType}' and is_active = true`);
      return { success: false, message: `No email configuration found for template: ${templateType}, event: ${eventType || 'N/A'}` };
    }

    console.log(`[EMAIL] ✅ Found ${rows.length} email config(s)`);
    console.log(`[EMAIL] Using config: template_type='${rows[0].template_type || 'N/A'}', event_type='${rows[0].event_type || 'N/A'}'`);
    console.log(`[EMAIL] Config ID: ${rows[0].config_id || 'N/A'}`);

    const config = rows[0];
    
    console.log(`[EMAIL] ✅ Found email config for template: ${templateType}`);
    console.log(`[EMAIL] SMTP Host: ${config.smtp_host}, Port: ${config.smtp_port}, Secure: ${config.smtp_secure}`);
    console.log(`[EMAIL] From: ${config.from_email} (${config.from_name})`);

    // Create transporter
    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: config.smtp_port,
      secure: config.smtp_secure,
      auth: {
        user: config.smtp_user,
        pass: config.smtp_password,
      },
    });
    
    // Verify connection
    try {
      await transporter.verify();
      console.log(`[EMAIL] ✅ SMTP connection verified successfully`);
    } catch (verifyError) {
      console.error(`[EMAIL] ❌ SMTP connection failed:`, verifyError.message);
      return { success: false, message: `SMTP connection failed: ${verifyError.message}` };
    }

    // Replace placeholders
    console.log(`[EMAIL] 🔍 Replacing placeholders...`);
    console.log(`[EMAIL] Employee data organization_name: ${employeeData.organization_name || 'NOT FOUND'}`);
    console.log(`[EMAIL] Original subject: ${(config.subject || '').substring(0, 100)}...`);
    console.log(`[EMAIL] Original body contains {{organization_name}}: ${(config.email_body || '').includes('{{organization_name}}')}`);
    
    const subject = replacePlaceholders(config.subject || '', employeeData);
    let htmlBody = replacePlaceholders(config.email_body || '', employeeData);
    
    // Debug: Check if organization_name was replaced
    const orgNameInSubject = subject.includes('{{organization_name}}') || subject.includes('{{ organization_name }}');
    const orgNameInBody = htmlBody.includes('{{organization_name}}') || htmlBody.includes('{{ organization_name }}');
    
    if (orgNameInSubject || orgNameInBody) {
      console.log(`[EMAIL] ⚠️ WARNING: {{organization_name}} still found after replacement!`);
      console.log(`[EMAIL] In subject: ${orgNameInSubject}, In body: ${orgNameInBody}`);
      console.log(`[EMAIL] Subject after: ${subject.substring(0, 150)}...`);
      console.log(`[EMAIL] Body snippet: ${htmlBody.substring(0, 300)}...`);
    } else {
      console.log(`[EMAIL] ✅ All placeholders replaced successfully`);
      console.log(`[EMAIL] Subject after replacement: ${subject.substring(0, 100)}...`);
    }

    // Convert plain text to HTML if needed (preserve line breaks)
    // If body doesn't contain HTML tags, convert \n to <br>
    if (!htmlBody.includes('<') && !htmlBody.includes('&lt;')) {
      htmlBody = htmlBody
        .replace(/\n/g, '<br>')
        .replace(/\r/g, '')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // **text** to <strong>
        .replace(/\*(.*?)\*/g, '<em>$1</em>'); // *text* to <em>
    }

    // Get employee email - use email from employeeData if available, otherwise query DB
    let toEmail = employeeData.email;
    
    if (!toEmail && employeeData.employee_id) {
      const empResult = await db.query(
        'SELECT email FROM employee_details WHERE employee_id = $1',
        [employeeData.employee_id]
      );

      if (empResult.rows.length === 0 || !empResult.rows[0].email) {
        console.log(`[EMAIL] ❌ No email found for employee: ${employeeData.employee_id}`);
        return { success: false, message: 'Employee email not found' };
      }

      toEmail = empResult.rows[0].email;
    }

    if (!toEmail) {
      console.log(`[EMAIL] ❌ No email address found for employee: ${employeeData.employee_id || employeeData.employee_name}`);
      return { success: false, message: 'Employee email not found' };
    }

    console.log(`[EMAIL] 📤 Attempting to send email to ${toEmail} using template: ${templateType}`);
    console.log(`[EMAIL] Subject: ${subject.substring(0, 50)}...`);
    console.log(`[EMAIL] Body length: ${htmlBody.length} characters`);

    // Send email
    const info = await transporter.sendMail({
      from: `"${config.from_name || 'Attendance System'}" <${config.from_email}>`,
      to: toEmail,
      subject: subject,
      html: htmlBody,
      text: htmlBody.replace(/<[^>]*>/g, ''), // Plain text version
    });

    console.log(`[EMAIL] ✅ Notification sent successfully to ${toEmail}`);
    console.log(`[EMAIL] Message ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[EMAIL] Error sending notification for template ${templateType}:`, error);
    return { success: false, message: error.message };
  }
}

// Send WhatsApp notification
async function sendWhatsAppNotification(templateType, employeeData) {
  try {
    // Get WhatsApp config for this template type
    const { rows } = await db.query(
      `SELECT api_url, api_key, phone_number_id, from_number, message_body
       FROM whatsapp_config 
       WHERE template_type = $1 AND is_active = true
       ORDER BY updated_at DESC
       LIMIT 1`,
      [templateType]
    );

    if (rows.length === 0) {
      console.log(`[WHATSAPP] No active WhatsApp config found for template: ${templateType}`);
      return { success: false, message: 'No WhatsApp configuration found' };
    }

    const config = rows[0];

    // Get employee phone number
    const empResult = await db.query(
      'SELECT phone_number FROM employee_details WHERE employee_id = $1',
      [employeeData.employee_id]
    );

    if (empResult.rows.length === 0 || !empResult.rows[0].phone_number) {
      console.log(`[WHATSAPP] No phone number found for employee: ${employeeData.employee_id}`);
      return { success: false, message: 'Employee phone number not found' };
    }

    const toPhone = empResult.rows[0].phone_number.replace(/\D/g, ''); // Remove non-digits

    // Replace placeholders
    const messageBody = replacePlaceholders(config.message_body || '', employeeData);

    // Prepare WhatsApp API request
    // Note: This is a generic implementation. Adjust based on your WhatsApp API provider
    const payload = {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'text',
      text: {
        body: messageBody,
      },
    };

    // Send WhatsApp message
    const response = await axios.post(config.api_url, payload, {
      headers: {
        'Authorization': `Bearer ${config.api_key}`,
        'Content-Type': 'application/json',
      },
    });

    console.log(`[WHATSAPP] Notification sent successfully to ${toPhone} for template: ${templateType}`);
    return { success: true, messageId: response.data?.messages?.[0]?.id };
  } catch (error) {
    console.error(`[WHATSAPP] Error sending notification for template ${templateType}:`, error.response?.data || error.message);
    return { success: false, message: error.response?.data?.error?.message || error.message };
  }
}

// Trigger notifications for attendance event
async function triggerAttendanceNotifications(status, employeeData) {
  // Determine template type based on status
  let templateType = '';
  if (status === 'checked_in') {
    templateType = 'check_in_notification';
  } else if (status === 'checked_out') {
    templateType = 'check_out_notification';
  } else {
    console.log(`[NOTIFICATION] Unknown status: ${status}`);
    return;
  }

  console.log(`[NOTIFICATION] Triggering notifications for ${status} with template: ${templateType}`);
  console.log(`[NOTIFICATION] Employee data:`, { 
    employee_id: employeeData.employee_id, 
    employee_name: employeeData.employee_name 
  });

  // Send email notification (async, don't wait for response)
  sendEmailNotification(templateType, employeeData)
    .then(result => {
      if (result.success) {
        console.log(`[NOTIFICATION] ✅ Email sent successfully for ${status}`);
      } else {
        console.log(`[NOTIFICATION] ❌ Email failed for ${status}: ${result.message}`);
      }
    })
    .catch(err => {
      console.error(`[NOTIFICATION] ❌ Email error for ${status}:`, err);
    });

  // Send WhatsApp notification (async, don't wait for response)
  sendWhatsAppNotification(templateType, employeeData)
    .then(result => {
      if (result.success) {
        console.log(`[NOTIFICATION] ✅ WhatsApp sent successfully for ${status}`);
      } else {
        console.log(`[NOTIFICATION] ❌ WhatsApp failed for ${status}: ${result.message}`);
      }
    })
    .catch(err => {
      console.error(`[NOTIFICATION] ❌ WhatsApp error for ${status}:`, err);
    });
}

// Trigger email notification for employee registration
async function triggerEmployeeRegistrationNotification(employeeData) {
  console.log(`[NOTIFICATION] 📧 Triggering registration notification for ${employeeData.employee_name}`);
  console.log(`[NOTIFICATION] Employee data:`, {
    employee_id: employeeData.employee_id,
    employee_name: employeeData.employee_name,
    employee_code: employeeData.employee_code,
    email: employeeData.email,
    organization_name: employeeData.organization_name
  });
  
  return sendEmailNotification('employee_registered', employeeData, 'employee_registered')
    .then(result => {
      if (result.success) {
        console.log(`[NOTIFICATION] ✅ Registration email sent successfully to ${employeeData.email || 'N/A'}`);
      } else {
        console.log(`[NOTIFICATION] ❌ Registration email failed: ${result.message}`);
        console.log(`[NOTIFICATION] 💡 Check if email config exists with event_type='employee_registered' and is_active=true`);
      }
      return result;
    })
    .catch(err => {
      console.error(`[NOTIFICATION] ❌ Registration email error:`, err);
      return { success: false, message: err.message };
    });
}

module.exports = {
  sendEmailNotification,
  sendWhatsAppNotification,
  triggerAttendanceNotifications,
  triggerEmployeeRegistrationNotification,
  replacePlaceholders,
};

