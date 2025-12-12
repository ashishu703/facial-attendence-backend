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
   */
  async processOpenSession(record) {
    try {
      const { attendance_id, employee_id, attendance_date, in_time, employee_type } = record;
      
      // Get employee's shifts
      const shifts = await getAllShifts(employee_type);
      if (shifts.length === 0) {
        console.log(`[DAILY-CLOSING] No shifts found for employee_type: ${employee_type}, skipping record ${attendance_id}`);
        return { processed: false, reason: 'no_shifts' };
      }

      const inTime = new Date(in_time);
      const detectedShift = detectShiftForTime(inTime, shifts);
      const shift = detectedShift?.shift || shifts[0];
      const shiftEndTime = buildShiftEndTime(inTime, shift);

      // Get presence detections after check-in time for this employee on this date
      const { rows: detections } = await db.query(
        `SELECT detection_time 
         FROM presence_detections 
         WHERE employee_id = $1 
           AND date = $2 
           AND detection_time > $3::timestamp
         ORDER BY detection_time DESC
         LIMIT 1`,
        [employee_id, attendance_date, in_time]
      );

      let tentativeOutTime = null;

      if (detections.length > 0) {
        // Use last detection time + buffer
        const lastDetectionTime = new Date(detections[0].detection_time);
        tentativeOutTime = new Date(
          lastDetectionTime.getTime() + this.config.FORGOT_CHECKOUT_BUFFER_MIN * 60 * 1000
        );
      } else {
        // No detections after check-in - assume worked until shift end
        tentativeOutTime = new Date(shiftEndTime);
      }

      // Clamp tentative out time to reasonable limits
      const maxOutTime = new Date(
        shiftEndTime.getTime() + this.config.MAX_OT_LIMIT_HOURS * 60 * 60 * 1000
      );
      const maxDayEnd = new Date(inTime.getTime() + this.config.MAX_DAY_DURATION_HOURS * 60 * 60 * 1000);
      
      const clampedOutTime = new Date(
        Math.min(tentativeOutTime.getTime(), maxOutTime.getTime(), maxDayEnd.getTime())
      );

      // Calculate session duration
      const sessionDurationMinutes = Math.round(
        (clampedOutTime.getTime() - inTime.getTime()) / (1000 * 60)
      );

      // Check if session is valid (meets minimum duration)
      const isValidSession = sessionDurationMinutes >= this.config.MIN_SESSION_MIN;

      if (!isValidSession) {
        // Mark as invalid session but still close it
        // NOTE: Data is NEVER deleted - preserved for audit trail
        await db.query(
          `UPDATE attendance_records 
           SET out_time = $1::timestamp,
               is_valid_session = false,
               total_working_hours_decimal = 0,
               extra_time_minutes = 0,
               ot_hours_decimal = 0
           WHERE attendance_id = $2`,
          [clampedOutTime.toISOString(), attendance_id]
        );

        console.log(
          `[DAILY-CLOSING] Closed invalid session ${attendance_id}: ` +
          `duration ${sessionDurationMinutes}min < ${this.config.MIN_SESSION_MIN}min`
        );

        return { processed: true, valid: false, duration: sessionDurationMinutes };
      }

      // Valid session - calculate metrics
      // Get count of completed sessions (excluding current one)
      const { rows: completedRows } = await db.query(
        `SELECT COUNT(*) as count 
         FROM attendance_records 
         WHERE employee_id = $1 
           AND attendance_date = $2 
           AND out_time IS NOT NULL
           AND attendance_id != $3`,
        [employee_id, attendance_date, attendance_id]
      );
      const completedCount = parseInt(completedRows[0]?.count || 0, 10);
      const isOTShift = completedCount > 0;

      const metrics = await calculateAttendanceMetrics(
        in_time,
        clampedOutTime.toISOString(),
        employee_type,
        isOTShift
      );

      // Update record with checkout time and metrics
      await db.query(
        `UPDATE attendance_records 
         SET out_time = $1::timestamp,
             is_valid_session = true,
             delay_by_minutes = $2,
             extra_time_minutes = $3,
             total_working_hours_decimal = $4,
             ot_hours_decimal = $5
         WHERE attendance_id = $6`,
        [
          clampedOutTime.toISOString(),
          metrics.delay_by_minutes,
          metrics.extra_time_minutes,
          metrics.total_working_hours_decimal,
          metrics.ot_hours_decimal,
          attendance_id
        ]
      );

      console.log(
        `[DAILY-CLOSING] Closed valid session ${attendance_id}: ` +
        `duration ${sessionDurationMinutes}min, hours: ${metrics.total_working_hours_decimal}`
      );

      return { processed: true, valid: true, duration: sessionDurationMinutes, metrics };
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

