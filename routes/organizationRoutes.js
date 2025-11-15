const express = require('express');
const db = require('../config/db');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Create organizations table if it doesn't exist
async function ensureOrganizationTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        organization_id SERIAL PRIMARY KEY,
        organization_name VARCHAR(255) NOT NULL UNIQUE,
        organization_code VARCHAR(50) UNIQUE,
        address TEXT,
        city VARCHAR(100),
        state VARCHAR(100),
        country VARCHAR(100),
        phone_number VARCHAR(20),
        email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Add organization_id column to employee_details if it doesn't exist
    await db.query(`
      ALTER TABLE employee_details 
      ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(organization_id) ON DELETE SET NULL
    `);
  } catch (e) {
    console.warn('[ORGANIZATION] Table creation warning:', e.message);
  }
}

// Initialize table on module load
ensureOrganizationTable();

// Get all organizations
router.get('/', protect, async (req, res) => {
  try {
    await ensureOrganizationTable();
    const { rows } = await db.query(`
      SELECT o.*, 
        (SELECT COUNT(*) FROM employee_details WHERE organization_id = o.organization_id) as employee_count
      FROM organizations o
      ORDER BY o.organization_name ASC
    `);
    res.json(rows);
  } catch (e) {
    console.error('List organizations error:', e);
    res.status(500).json({ message: 'Failed to fetch organizations' });
  }
});

// Get single organization
router.get('/:id', protect, async (req, res) => {
  const { id } = req.params;
  try {
    await ensureOrganizationTable();
    const { rows } = await db.query(
      `SELECT o.*,
        (SELECT COUNT(*) FROM employee_details WHERE organization_id = o.organization_id) as employee_count
       FROM organizations o 
       WHERE organization_id = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Get organization error:', e);
    res.status(500).json({ message: 'Failed to fetch organization' });
  }
});

// Create new organization
router.post('/', protect, async (req, res) => {
  const { organization_name, organization_code, address, city, state, country, phone_number, email } = req.body;
  
  if (!organization_name) {
    return res.status(400).json({ message: 'Organization name is required' });
  }

  try {
    await ensureOrganizationTable();
    const { rows } = await db.query(
      `INSERT INTO organizations 
       (organization_name, organization_code, address, city, state, country, phone_number, email) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
       RETURNING *`,
      [organization_name, organization_code, address, city, state, country, phone_number, email]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('Create organization error:', e);
    if (e.code === '23505') { // Unique constraint violation
      res.status(400).json({ message: 'Organization name or code already exists' });
    } else {
      res.status(500).json({ message: 'Failed to create organization' });
    }
  }
});

// Update organization
router.put('/:id', protect, async (req, res) => {
  const { id } = req.params;
  const { organization_name, organization_code, address, city, state, country, phone_number, email } = req.body;
  
  try {
    await ensureOrganizationTable();
    const { rows } = await db.query(
      `UPDATE organizations 
       SET organization_name=$1, organization_code=$2, address=$3, city=$4, state=$5, 
           country=$6, phone_number=$7, email=$8, updated_at=CURRENT_TIMESTAMP
       WHERE organization_id=$9
       RETURNING *`,
      [organization_name, organization_code, address, city, state, country, phone_number, email, id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Update organization error:', e);
    if (e.code === '23505') {
      res.status(400).json({ message: 'Organization name or code already exists' });
    } else {
      res.status(500).json({ message: 'Failed to update organization' });
    }
  }
});

// Delete organization
router.delete('/:id', protect, async (req, res) => {
  const { id } = req.params;
  try {
    await ensureOrganizationTable();
    // Set organization_id to NULL for all employees in this organization
    await db.query('UPDATE employee_details SET organization_id = NULL WHERE organization_id = $1', [id]);
    
    const result = await db.query('DELETE FROM organizations WHERE organization_id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ message: 'Organization not found' });
    res.status(204).end();
  } catch (e) {
    console.error('Delete organization error:', e);
    res.status(500).json({ message: 'Failed to delete organization' });
  }
});

module.exports = router;

