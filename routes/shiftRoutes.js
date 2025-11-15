const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { protect } = require('../middleware/authMiddleware');

router.use(async (_req, _res, next) => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS shift_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        employee_type TEXT NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        grace_before INTEGER DEFAULT 0,
        grace_after INTEGER DEFAULT 0,
        presence_time INTEGER DEFAULT 3,
        presence_count INTEGER DEFAULT 3,
        presence_window INTEGER DEFAULT 5,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await db.query(`
      ALTER TABLE shift_settings 
      ADD COLUMN IF NOT EXISTS grace_before INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS grace_after INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS presence_time INTEGER DEFAULT 3,
      ADD COLUMN IF NOT EXISTS presence_count INTEGER DEFAULT 3,
      ADD COLUMN IF NOT EXISTS presence_window INTEGER DEFAULT 5;
    `);
  } catch (e) {
    console.error('Shift settings table setup error:', e);
  }
  next();
});

router.get('/', protect, async (_req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM shift_settings ORDER BY created_at DESC');
    res.json(rows);
  } catch (error) {
    console.error('List shifts error:', error);
    res.status(500).json({ message: 'Failed to fetch shifts' });
  }
});

router.post('/', protect, async (req, res) => {
  try {
    const { 
      name, employee_type, start_time, end_time, 
      grace_before = 0, grace_after = 0, 
      presence_time = 3, presence_count = 3, presence_window = 5 
    } = req.body;
    const { rows } = await db.query(
      `INSERT INTO shift_settings (name, employee_type, start_time, end_time, grace_before, grace_after, presence_time, presence_count, presence_window)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [name, employee_type, start_time, end_time, grace_before, grace_after, presence_time, presence_count, presence_window]
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Create shift error:', error);
    res.status(500).json({ message: 'Failed to create shift' });
  }
});

router.put('/:id', protect, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      name, employee_type, start_time, end_time, 
      grace_before, grace_after, 
      presence_time, presence_count, presence_window 
    } = req.body;
    const { rows } = await db.query(
      `UPDATE shift_settings 
       SET name=$1, employee_type=$2, start_time=$3, end_time=$4,
           grace_before=COALESCE($5, grace_before), grace_after=COALESCE($6, grace_after),
           presence_time=COALESCE($7, presence_time), presence_count=COALESCE($8, presence_count),
           presence_window=COALESCE($9, presence_window)
       WHERE id=$10 RETURNING *`,
      [name, employee_type, start_time, end_time, grace_before, grace_after, 
       presence_time, presence_count, presence_window, id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Shift not found' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Update shift error:', error);
    res.status(500).json({ message: 'Failed to update shift' });
  }
});

router.delete('/:id', protect, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM shift_settings WHERE id=$1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ message: 'Shift not found' });
    res.status(204).end();
  } catch (error) {
    console.error('Delete shift error:', error);
    res.status(500).json({ message: 'Failed to delete shift' });
  }
});

router.get('/by-type/:employeeType', protect, async (req, res) => {
  try {
    const { employeeType } = req.params;
    const { rows } = await db.query(
      'SELECT * FROM shift_settings WHERE employee_type=$1 ORDER BY created_at DESC LIMIT 1',
      [employeeType]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'No shift found for employee type' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Get shift by type error:', error);
    res.status(500).json({ message: 'Failed to fetch shift' });
  }
});

module.exports = router;


