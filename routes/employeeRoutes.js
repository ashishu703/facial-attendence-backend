const express = require('express');
const db = require('../config/db');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

async function ensureEmployeeTypeEnum() {
  try {
    await db.query(`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'employee_type_enum') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname='employee_type_enum' AND e.enumlabel='Office Staff') THEN
          ALTER TYPE employee_type_enum ADD VALUE 'Office Staff';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname='employee_type_enum' AND e.enumlabel='Factory Staff') THEN
          ALTER TYPE employee_type_enum ADD VALUE 'Factory Staff';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname='employee_type_enum' AND e.enumlabel='Intern') THEN
          ALTER TYPE employee_type_enum ADD VALUE 'Intern';
        END IF;
      END IF;
    END $$;`);
  } catch (e) {
    console.warn('[ENUM] Check/alter failed (safe if not enum):', e.message);
  }
}

// Removed duplicate verify/register endpoints. Those are now handled by dedicated microservices.

// List all employees (basic fields)
router.get('/', protect, async (_req, res) => {
  try {
    // Ensure optional columns exist so SELECT doesn't fail on fresh DBs
    await db.query(`ALTER TABLE employee_details ADD COLUMN IF NOT EXISTS employee_code TEXT;`);
    await db.query(`ALTER TABLE employee_details ADD COLUMN IF NOT EXISTS aadhar_last4 TEXT;`);

    const { rows } = await db.query(`
      SELECT employee_id, employee_name, department, position, email, phone_number, employee_type, aadhar_last4, employee_code
      FROM employee_details
      ORDER BY employee_name ASC
    `);
    res.json(rows);
  } catch (e) {
    console.error('List employees error:', e);
    res.status(500).json({ message: 'Failed to fetch employees' });
  }
});

// Update employee
router.put('/:id', protect, async (req, res) => {
  const { id } = req.params;
  const { employee_name, department, position, email, phone_number, employee_type, aadhar_last4, employee_code } = req.body;
  try {
    await ensureEmployeeTypeEnum();

    const { rows } = await db.query(
      `UPDATE employee_details
       SET employee_name=$1, department=$2, position=$3, email=$4, phone_number=$5, employee_type=$6, aadhar_last4=$7, employee_code=$8
       WHERE employee_id=$9
       RETURNING employee_id, employee_name, department, position, email, phone_number, employee_type, aadhar_last4, employee_code`,
      [employee_name, department, position, email, phone_number, employee_type, aadhar_last4, employee_code, id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Employee not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Update employee error:', e);
    res.status(500).json({ message: 'Failed to update employee' });
  }
});

// Delete employee (and related attendance records)
router.delete('/:id', protect, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('BEGIN');
    await db.query('DELETE FROM attendance_records WHERE employee_id = $1', [id]);
    const result = await db.query('DELETE FROM employee_details WHERE employee_id = $1', [id]);
    await db.query('COMMIT');
    if (result.rowCount === 0) return res.status(404).json({ message: 'Employee not found' });
    res.status(204).end();
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('Delete employee error:', e);
    res.status(500).json({ message: 'Failed to delete employee' });
  }
});

module.exports = router;

