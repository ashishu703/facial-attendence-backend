/**
 * Daily Closing Service
 * 
 * Handles forgot checkout scenarios by analyzing presence_detections
 * and automatically closing open attendance sessions.
 * 
 * This service runs once per day (typically late night) and:
 * 1. Finds all open sessions (out_time IS NULL)
 * 2. Uses presence_detections to infer checkout time
 * 3. Closes sessions with realistic checkout times
 * 4. Marks invalid sessions (too short) appropriately
 * 
 * Audit & Tamper Safety: Even invalid sessions are preserved in database.
 * Raw punches are NEVER deleted, providing complete audit trail for HR investigations.
 */

const db = require('../config/db');
const attendanceConfig = require('./attendanceConfigService');
const {
  getAllShifts,
  detectShiftForTime,
  buildShiftEndTime,
  buildLocalTime,
  calculateAttendanceMetrics
} = require('./attendanceLogicService');

class DailyClosingService {
  constructor() {
    this.config = attendanceConfig;
  }

  /**
   * Process forgot checkout for a single open session
   * 
   * NOTE: Changed behavior - No longer automatically sets checkout time.
   * Employees who didn't check out will remain with null checkout time
   * and will be marked as "Absent" by the consolidation service.
   */
  async processOpenSession(record) {
    try {
      const { attendance_id, employee_id, attendance_date, in_time, employee_type } = record;
      
      // Do NOT automatically set checkout time
      // Leave checkout as null so consolidation service can mark as "Absent"
      console.log(
        `[DAILY-CLOSING] Skipping automatic checkout for session ${attendance_id}: ` +
        `Employee will be marked as "Not checked out" and "Absent" by consolidation service`
      );

      return { processed: false, reason: 'auto_checkout_disabled' };
    } catch (error) {
      console.error(`[DAILY-CLOSING] Error processing session ${record.attendance_id}:`, error);
      return { processed: false, reason: 'error', error: error.message };
    }
  }


  /**
   * Process all open sessions for a specific date
   */
  async processDate(date) {
    try {
      console.log(`[DAILY-CLOSING] Processing open sessions for date: ${date}`);

      // Find all open sessions for this date
      const { rows: openSessions } = await db.query(
        `SELECT r.attendance_id, r.employee_id, r.attendance_date, r.in_time,
                d.employee_type
         FROM attendance_records r
         JOIN employee_details d ON r.employee_id = d.employee_id
         WHERE r.attendance_date = $1 
           AND r.out_time IS NULL
         ORDER BY r.in_time ASC`,
        [date]
      );

      if (openSessions.length === 0) {
        console.log(`[DAILY-CLOSING] No open sessions found for date: ${date}`);
        return { processed: 0, valid: 0, invalid: 0 };
      }

      console.log(`[DAILY-CLOSING] Found ${openSessions.length} open sessions`);

      let processed = 0;
      let valid = 0;
      let invalid = 0;

      for (const session of openSessions) {
        const result = await this.processOpenSession(session);
        if (result.processed) {
          processed++;
          if (result.valid) {
            valid++;
          } else {
            invalid++;
          }
        }
      }

      console.log(
        `[DAILY-CLOSING] Completed processing date ${date}: ` +
        `${processed} processed (${valid} valid, ${invalid} invalid)`
      );

      return { processed, valid, invalid };
    } catch (error) {
      console.error(`[DAILY-CLOSING] Error processing date ${date}:`, error);
      throw error;
    }
  }

  /**
   * Process yesterday's open sessions (main entry point for daily job)
   */
  async processYesterday() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    return await this.processDate(dateStr);
  }

  /**
   * Process today's open sessions (for manual/admin trigger)
   */
  async processToday() {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];

    return await this.processDate(dateStr);
  }
}

const dailyClosingService = new DailyClosingService();

module.exports = {
  processOpenSession: (record) => dailyClosingService.processOpenSession(record),
  processDate: (date) => dailyClosingService.processDate(date),
  processYesterday: () => dailyClosingService.processYesterday(),
  processToday: () => dailyClosingService.processToday()
};

