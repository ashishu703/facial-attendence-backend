/**
 * Database Migration Service
 * 
 * Ensures attendance_records table has all required fields for new logic:
 * - is_valid_session (boolean)
 * - missing_punch (boolean)
 */

const db = require('../config/db');

class DBMigrationService {
  /**
   * Ensure all required columns exist in attendance_records
   */
  async ensureColumns() {
    try {
      // Add is_valid_session column (NULL = legacy record, assume valid)
      await db.query(`
        ALTER TABLE attendance_records 
        ADD COLUMN IF NOT EXISTS is_valid_session BOOLEAN DEFAULT NULL
      `);

      // Add missing_punch column (will be calculated during consolidation)
      await db.query(`
        ALTER TABLE attendance_records 
        ADD COLUMN IF NOT EXISTS missing_punch BOOLEAN DEFAULT FALSE
      `);

      // Create index for faster queries on valid sessions
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_attendance_valid_session 
        ON attendance_records(employee_id, attendance_date, is_valid_session)
        WHERE is_valid_session = true
      `);

      console.log('[DB-MIGRATION] ✅ Attendance records columns ensured');
    } catch (error) {
      console.error('[DB-MIGRATION] Error ensuring columns:', error);
      throw error;
    }
  }
}

const dbMigrationService = new DBMigrationService();

module.exports = {
  ensureColumns: () => dbMigrationService.ensureColumns()
};

