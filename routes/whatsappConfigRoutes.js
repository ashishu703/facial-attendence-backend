const express = require('express');
const db = require('../config/db');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Create whatsapp_config table if it doesn't exist
async function ensureWhatsAppConfigTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_config (
        config_id SERIAL PRIMARY KEY,
        api_url VARCHAR(500) NOT NULL,
        api_key VARCHAR(255) NOT NULL,
        phone_number_id VARCHAR(255),
        business_account_id VARCHAR(255),
        from_number VARCHAR(20),
        template_type VARCHAR(100) NOT NULL,
        message_body TEXT NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    console.warn('[WHATSAPP_CONFIG] Table creation warning:', e.message);
  }
}

// Initialize table on module load
ensureWhatsAppConfigTable();

// Get all WhatsApp configurations
router.get('/', protect, async (req, res) => {
  try {
    await ensureWhatsAppConfigTable();
    const { rows } = await db.query(`
      SELECT config_id, api_url, api_key, phone_number_id, business_account_id,
             from_number, template_type, message_body, is_active, created_at, updated_at
      FROM whatsapp_config
      ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error('List WhatsApp configs error:', e);
    res.status(500).json({ message: 'Failed to fetch WhatsApp configurations' });
  }
});

// Get single WhatsApp configuration
router.get('/:id', protect, async (req, res) => {
  const { id } = req.params;
  try {
    await ensureWhatsAppConfigTable();
    const { rows } = await db.query(
      `SELECT config_id, api_url, api_key, phone_number_id, business_account_id,
              from_number, template_type, message_body, is_active, created_at, updated_at
       FROM whatsapp_config 
       WHERE config_id = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'WhatsApp configuration not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Get WhatsApp config error:', e);
    res.status(500).json({ message: 'Failed to fetch WhatsApp configuration' });
  }
});

// Get WhatsApp configuration by template type
router.get('/template/:type', protect, async (req, res) => {
  const { type } = req.params;
  try {
    await ensureWhatsAppConfigTable();
    const { rows } = await db.query(
      `SELECT config_id, api_url, api_key, phone_number_id, business_account_id,
              from_number, template_type, message_body, is_active, created_at, updated_at
       FROM whatsapp_config 
       WHERE template_type = $1 AND is_active = true
       ORDER BY updated_at DESC
       LIMIT 1`,
      [type]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'WhatsApp configuration not found for this template type' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Get WhatsApp config by type error:', e);
    res.status(500).json({ message: 'Failed to fetch WhatsApp configuration' });
  }
});

// Get all unique template types
router.get('/templates/list', protect, async (req, res) => {
  try {
    await ensureWhatsAppConfigTable();
    const { rows } = await db.query(`
      SELECT DISTINCT template_type 
      FROM whatsapp_config 
      WHERE is_active = true
      ORDER BY template_type ASC
    `);
    res.json(rows.map(r => r.template_type));
  } catch (e) {
    console.error('List template types error:', e);
    res.status(500).json({ message: 'Failed to fetch template types' });
  }
});

// Create new WhatsApp configuration
router.post('/', protect, async (req, res) => {
  const { 
    api_url, api_key, phone_number_id, business_account_id, from_number,
    template_type, message_body, is_active 
  } = req.body;
  
  if (!api_url || !api_key || !template_type || !message_body) {
    return res.status(400).json({ message: 'Required fields are missing' });
  }

  try {
    await ensureWhatsAppConfigTable();
    const { rows } = await db.query(
      `INSERT INTO whatsapp_config 
       (api_url, api_key, phone_number_id, business_account_id, from_number, 
        template_type, message_body, is_active) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
       RETURNING config_id, api_url, api_key, phone_number_id, business_account_id,
                 from_number, template_type, message_body, is_active, created_at, updated_at`,
      [api_url, api_key, phone_number_id, business_account_id, from_number, 
       template_type, message_body, is_active !== undefined ? is_active : true]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('Create WhatsApp config error:', e);
    res.status(500).json({ message: 'Failed to create WhatsApp configuration' });
  }
});

// Update WhatsApp configuration
router.put('/:id', protect, async (req, res) => {
  const { id } = req.params;
  const { 
    api_url, api_key, phone_number_id, business_account_id, from_number,
    template_type, message_body, is_active 
  } = req.body;
  
  try {
    await ensureWhatsAppConfigTable();
    const { rows } = await db.query(
      `UPDATE whatsapp_config 
       SET api_url=$1, api_key=$2, phone_number_id=$3, business_account_id=$4, 
           from_number=$5, template_type=$6, message_body=$7, is_active=$8, 
           updated_at=CURRENT_TIMESTAMP
       WHERE config_id=$9
       RETURNING config_id, api_url, api_key, phone_number_id, business_account_id,
                 from_number, template_type, message_body, is_active, created_at, updated_at`,
      [api_url, api_key, phone_number_id, business_account_id, from_number, 
       template_type, message_body, is_active, id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'WhatsApp configuration not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Update WhatsApp config error:', e);
    res.status(500).json({ message: 'Failed to update WhatsApp configuration' });
  }
});

// Delete WhatsApp configuration
router.delete('/:id', protect, async (req, res) => {
  const { id } = req.params;
  try {
    await ensureWhatsAppConfigTable();
    const result = await db.query('DELETE FROM whatsapp_config WHERE config_id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ message: 'WhatsApp configuration not found' });
    res.status(204).end();
  } catch (e) {
    console.error('Delete WhatsApp config error:', e);
    res.status(500).json({ message: 'Failed to delete WhatsApp configuration' });
  }
});

module.exports = router;

