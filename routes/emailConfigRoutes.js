const express = require('express');
const db = require('../config/db');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Create email_config table if it doesn't exist
async function ensureEmailConfigTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS email_config (
        config_id SERIAL PRIMARY KEY,
        smtp_host VARCHAR(255) NOT NULL,
        smtp_port INTEGER NOT NULL DEFAULT 587,
        smtp_secure BOOLEAN DEFAULT false,
        smtp_user VARCHAR(255) NOT NULL,
        smtp_password VARCHAR(255) NOT NULL,
        from_email VARCHAR(255) NOT NULL,
        from_name VARCHAR(255),
        template_type VARCHAR(100) NOT NULL,
        event_type VARCHAR(50),
        subject VARCHAR(500),
        email_body TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    console.warn('[EMAIL_CONFIG] Table creation warning:', e.message);
  }
}

// Initialize table on module load
ensureEmailConfigTable();

// Add event_type column if it doesn't exist
async function ensureEventTypeColumn() {
  try {
    await db.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'email_config' AND column_name = 'event_type'
        ) THEN
          ALTER TABLE email_config ADD COLUMN event_type VARCHAR(50);
        END IF;
      END $$;
    `);
  } catch (e) {
    console.warn('[EMAIL_CONFIG] Column addition warning:', e.message);
  }
}

ensureEventTypeColumn();

// Get all email configurations
router.get('/', protect, async (req, res) => {
  try {
    await ensureEmailConfigTable();
    const { rows } = await db.query(`
      SELECT config_id, smtp_host, smtp_port, smtp_secure, smtp_user, 
             from_email, from_name, template_type, event_type, subject, email_body, 
             is_active, created_at, updated_at
      FROM email_config
      ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error('List email configs error:', e);
    res.status(500).json({ message: 'Failed to fetch email configurations' });
  }
});

// Get single email configuration
router.get('/:id', protect, async (req, res) => {
  const { id } = req.params;
  try {
    await ensureEmailConfigTable();
    const { rows } = await db.query(
      `SELECT config_id, smtp_host, smtp_port, smtp_secure, smtp_user, 
              from_email, from_name, template_type, subject, email_body, 
              is_active, created_at, updated_at
       FROM email_config 
       WHERE config_id = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Email configuration not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Get email config error:', e);
    res.status(500).json({ message: 'Failed to fetch email configuration' });
  }
});

// Get email configuration by template type
router.get('/template/:type', protect, async (req, res) => {
  const { type } = req.params;
  try {
    await ensureEmailConfigTable();
    const { rows } = await db.query(
      `SELECT config_id, smtp_host, smtp_port, smtp_secure, smtp_user, 
              from_email, from_name, template_type, subject, email_body, 
              is_active, created_at, updated_at
       FROM email_config 
       WHERE template_type = $1 AND is_active = true
       ORDER BY updated_at DESC
       LIMIT 1`,
      [type]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Email configuration not found for this template type' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Get email config by type error:', e);
    res.status(500).json({ message: 'Failed to fetch email configuration' });
  }
});

// Get all unique template types
router.get('/templates/list', protect, async (req, res) => {
  try {
    await ensureEmailConfigTable();
    const { rows } = await db.query(`
      SELECT DISTINCT template_type 
      FROM email_config 
      WHERE is_active = true
      ORDER BY template_type ASC
    `);
    res.json(rows.map(r => r.template_type));
  } catch (e) {
    console.error('List template types error:', e);
    res.status(500).json({ message: 'Failed to fetch template types' });
  }
});

// Create new email configuration
router.post('/', protect, async (req, res) => {
  const { 
    smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, 
    from_email, from_name, template_type, event_type, custom_event_name, subject, email_body, is_active 
  } = req.body;
  
  if (!smtp_host || !smtp_port || !smtp_user || !smtp_password || !from_email || !template_type) {
    return res.status(400).json({ message: 'Required fields are missing' });
  }

  // For custom events, use custom_event_name as the event identifier
  let finalEventType = event_type;
  if (event_type === 'custom' && custom_event_name) {
    finalEventType = custom_event_name;
  }

  try {
    await ensureEmailConfigTable();
    await ensureEventTypeColumn();
    const { rows } = await db.query(
      `INSERT INTO email_config 
       (smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, from_email, from_name, 
        template_type, event_type, subject, email_body, is_active) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
       RETURNING config_id, smtp_host, smtp_port, smtp_secure, smtp_user, 
                 from_email, from_name, template_type, event_type, subject, email_body, 
                 is_active, created_at, updated_at`,
      [smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, from_email, from_name, 
       template_type, finalEventType || null, subject, email_body, is_active !== undefined ? is_active : true]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('Create email config error:', e);
    res.status(500).json({ message: 'Failed to create email configuration' });
  }
});

// Update email configuration
router.put('/:id', protect, async (req, res) => {
  const { id } = req.params;
  const { 
    smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, 
    from_email, from_name, template_type, event_type, custom_event_name, subject, email_body, is_active 
  } = req.body;
  
  // For custom events, use custom_event_name as the event identifier
  let finalEventType = event_type;
  if (event_type === 'custom' && custom_event_name) {
    finalEventType = custom_event_name;
  }
  
  try {
    await ensureEmailConfigTable();
    await ensureEventTypeColumn();
    
    // If password is provided, update it; otherwise keep existing password
    let query, params;
    if (smtp_password && smtp_password.trim() !== '') {
      // Update with new password
      query = `UPDATE email_config 
               SET smtp_host=$1, smtp_port=$2, smtp_secure=$3, smtp_user=$4, smtp_password=$5,
                   from_email=$6, from_name=$7, template_type=$8, event_type=$9, subject=$10, email_body=$11,
                   is_active=$12, updated_at=CURRENT_TIMESTAMP
               WHERE config_id=$13
               RETURNING config_id, smtp_host, smtp_port, smtp_secure, smtp_user, 
                         from_email, from_name, template_type, event_type, subject, email_body, 
                         is_active, created_at, updated_at`;
      params = [smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, from_email, from_name, 
                template_type, finalEventType || null, subject, email_body, is_active, id];
    } else {
      // Update without changing password
      query = `UPDATE email_config 
               SET smtp_host=$1, smtp_port=$2, smtp_secure=$3, smtp_user=$4,
                   from_email=$5, from_name=$6, template_type=$7, event_type=$8, subject=$9, email_body=$10,
                   is_active=$11, updated_at=CURRENT_TIMESTAMP
               WHERE config_id=$12
               RETURNING config_id, smtp_host, smtp_port, smtp_secure, smtp_user, 
                         from_email, from_name, template_type, event_type, subject, email_body, 
                         is_active, created_at, updated_at`;
      params = [smtp_host, smtp_port, smtp_secure, smtp_user, from_email, from_name, 
                template_type, finalEventType || null, subject, email_body, is_active, id];
    }
    
    const { rows } = await db.query(query, params);
    if (rows.length === 0) return res.status(404).json({ message: 'Email configuration not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Update email config error:', e);
    res.status(500).json({ message: 'Failed to update email configuration' });
  }
});

// Delete email configuration
router.delete('/:id', protect, async (req, res) => {
  const { id } = req.params;
  try {
    await ensureEmailConfigTable();
    const result = await db.query('DELETE FROM email_config WHERE config_id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ message: 'Email configuration not found' });
    res.status(204).end();
  } catch (e) {
    console.error('Delete email config error:', e);
    res.status(500).json({ message: 'Failed to delete email configuration' });
  }
});

module.exports = router;

