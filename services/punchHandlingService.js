/**
 * Punch Handling Service
 * 
 * Handles real-time attendance punches with:
 * - Duplicate punch filtering
 * - IN/OUT decision logic
 * - Minimum session validation
 */

const db = require('../config/db');
const attendanceConfig = require('./attendanceConfigService');
const {
  getAllShifts,
  detectShiftForTime,
  findShiftForPunchWithGrace,
  buildLocalTime,
  buildShiftEndTime,
  calculateAttendanceMetrics
} = require('./attendanceLogicService');

class PunchHandlingService {
  constructor() {
    this.config = attendanceConfig;
  }

  /**
   * Get the last punch for an employee on a date (regardless of IN/OUT)
   */
  async getLastPunch(employeeId, date) {
    try {
      const { rows } = await db.query(
        `SELECT attendance_id, in_time, out_time, attendance_date
         FROM attendance_records
         WHERE employee_id = $1 AND attendance_date = $2
         ORDER BY 
           COALESCE(out_time, in_time) DESC,
           in_time DESC
         LIMIT 1`,
        [employeeId, date]
      );

      if (rows.length === 0) return null;

      const record = rows[0];
      // Return the most recent timestamp (either out_time or in_time)
      const lastPunchTime = record.out_time || record.in_time;
      
      return {
        record,
        lastPunchTime: lastPunchTime ? new Date(lastPunchTime) : null,
        isOpenSession: record.in_time && !record.out_time
      };
    } catch (error) {
      console.error('Error getting last punch:', error);
      return null;
    }
  }

  /**
   * Check if a punch is a duplicate (within DUPLICATE_WINDOW_MIN)
   */
  isDuplicatePunch(lastPunchTime, currentPunchTime) {
    if (!lastPunchTime) return false;

    const timeDiffMinutes = Math.abs(
      (currentPunchTime.getTime() - lastPunchTime.getTime()) / (1000 * 60)
    );

    return timeDiffMinutes <= this.config.DUPLICATE_WINDOW_MIN;
  }

  /**
   * Determine if current punch should be IN or OUT
   */
  async determinePunchType(employeeId, date) {
    // Check for open session (IN without OUT)
    const { rows: openSessions } = await db.query(
      `SELECT attendance_id, in_time
       FROM attendance_records
       WHERE employee_id = $1 
         AND attendance_date = $2 
         AND in_time IS NOT NULL
         AND out_time IS NULL
       ORDER BY in_time DESC
       LIMIT 1`,
      [employeeId, date]
    );

    if (openSessions.length > 0) {
      return { type: 'OUT', openSession: openSessions[0] };
    }

    return { type: 'IN', openSession: null };
  }

  /**
   * Validate and process a check-in
   * 
   * Rule: If shift end has passed and employee already has a completed session on this date,
   * the new check-in should be on the next date, not the same date.
   */
  async processCheckIn(employeeId, employeeType, timestampStr, date, location) {
    const checkInTime = new Date(timestampStr);
    const shifts = await getAllShifts(employeeType);

    if (shifts.length === 0) {
      throw new Error('No shift settings found for your employee type.');
    }

    // Check if employee has any completed sessions on this date
    const { rows: completedSessions } = await db.query(
      `SELECT in_time, out_time 
       FROM attendance_records 
       WHERE employee_id = $1 
         AND attendance_date = $2 
         AND in_time IS NOT NULL 
         AND out_time IS NOT NULL
       ORDER BY out_time DESC
       LIMIT 1`,
      [employeeId, date]
    );

    // If there's a completed session, check if current check-in is after shift end
    // Rule: Shift end ke baad naya check-in same date mein nahi hoga, next date mein hoga
    if (completedSessions.length > 0) {
      const lastCheckOut = new Date(completedSessions[0].out_time);
      
      // Detect shift for the last checkout to get shift end time
      const detectedShift = detectShiftForTime(lastCheckOut, shifts);
      const shift = detectedShift?.shift || shifts[0];
      const shiftEndTime = buildShiftEndTime(lastCheckOut, shift);
      
      // Add grace period to shift end (to allow some buffer)
      const shiftEndWithGrace = new Date(
        shiftEndTime.getTime() + (shift.graceAfter || 0) * 60 * 1000
      );
      
      // If current check-in time is after shift end + grace, it should be on next date
      if (checkInTime.getTime() > shiftEndWithGrace.getTime()) {
        const nextDate = new Date(date);
        nextDate.setDate(nextDate.getDate() + 1);
        const nextDateStr = nextDate.toISOString().split('T')[0];
        
        const shiftEndTimeStr = shiftEndTime.toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
          timeZone: 'Asia/Kolkata'
        });
        
        throw new Error(
          `Shift has ended at ${shiftEndTimeStr}. New check-in after shift end should be on next date (${nextDateStr}). ` +
          `Please check-in tomorrow for the new shift.`
        );
      }
    }

    // Check if check-in is within any shift window
    const match = findShiftForPunchWithGrace(checkInTime, shifts);
    const matchShift = match?.shift || null;

    if (!matchShift) {
      throw new Error('Check-in not within any shift window.');
    }

    // Calculate delay at check-in
    let delayAtCheckInMinutes = 0;
    const shiftStart = buildLocalTime(checkInTime, matchShift.startHour, matchShift.startMinute);
    if (checkInTime.getTime() > shiftStart.getTime()) {
      delayAtCheckInMinutes = Math.round(
        (checkInTime.getTime() - shiftStart.getTime()) / (1000 * 60)
      );
    }

    // Insert check-in record
    const { rows } = await db.query(
      `INSERT INTO attendance_records 
       (employee_id, attendance_date, in_time, location_in, delay_by_minutes, is_valid_session)
       VALUES ($1, $2, $3::timestamp, $4, $5, NULL)
       RETURNING attendance_id`,
      [employeeId, date, timestampStr, location, delayAtCheckInMinutes]
    );

    return {
      attendance_id: rows[0].attendance_id,
      in_time: timestampStr,
      delay_by_minutes: delayAtCheckInMinutes,
      shift_name: matchShift.name
    };
  }

  /**
   * Validate and process a check-out
   */
  async processCheckOut(openSession, employeeId, employeeType, timestampStr, date, location) {
    const checkInTime = new Date(openSession.in_time);
    const checkOutTime = new Date(timestampStr);

    // Validate checkout time is after check-in time
    if (checkOutTime.getTime() <= checkInTime.getTime()) {
      throw new Error('Check-out time must be after check-in time.');
    }

    // Calculate session duration
    const sessionDurationMinutes = Math.round(
      (checkOutTime.getTime() - checkInTime.getTime()) / (1000 * 60)
    );

    // Check if session meets minimum duration
    const isValidSession = sessionDurationMinutes >= this.config.MIN_SESSION_MIN;

    /**
     * Audit & Tamper Safety: Even when a session is marked is_valid_session = false,
     * the raw punches are NEVER deleted. This provides a full audit trail for any 
     * future HR investigation. All data is preserved, ensuring complete transparency
     * and compliance with audit requirements.
     * 
     * Invalid sessions are marked but retained in database with:
     * - is_valid_session = false
     * - total_working_hours_decimal = 0 (not counted in working hours)
     * - But in_time and out_time preserved for audit trail
     */

    // Get completed count to determine if this is OT shift
    const { rows: completedRows } = await db.query(
      `SELECT COUNT(*) as count 
       FROM attendance_records 
       WHERE employee_id = $1 
         AND attendance_date = $2 
         AND out_time IS NOT NULL
         AND attendance_id != $3`,
      [employeeId, date, openSession.attendance_id]
    );
    const completedCount = parseInt(completedRows[0]?.count || 0, 10);
    const isOTShift = completedCount > 0;

    // Calculate metrics
    const metrics = await calculateAttendanceMetrics(
      openSession.in_time,
      timestampStr,
      employeeType,
      isOTShift
    );

    // Get shift name
    const shifts = await getAllShifts(employeeType);
    const detectedShift = detectShiftForTime(checkInTime, shifts);
    const shift = detectedShift?.shift || shifts[0];
    const shiftName = shift.name || 'Unknown Shift';

    // Update record
    // NOTE: Even invalid sessions are preserved - never deleted for audit trail
    await db.query(
      `UPDATE attendance_records
       SET out_time = $1::timestamp,
           location_out = $2,
           delay_by_minutes = $3,
           extra_time_minutes = $4,
           total_working_hours_decimal = $5,
           ot_hours_decimal = $6,
           is_valid_session = $7
       WHERE attendance_id = $8`,
      [
        timestampStr,
        location,
        metrics.delay_by_minutes,
        metrics.extra_time_minutes,
        isValidSession ? metrics.total_working_hours_decimal : 0,
        isValidSession ? metrics.ot_hours_decimal : 0,
        isValidSession,
        openSession.attendance_id
      ]
    );

    return {
      attendance_id: openSession.attendance_id,
      out_time: timestampStr,
      total_working_hours_decimal: isValidSession ? metrics.total_working_hours_decimal : 0,
      ot_hours_decimal: isValidSession ? metrics.ot_hours_decimal : 0,
      is_valid_session: isValidSession,
      session_duration_minutes: sessionDurationMinutes,
      is_ot: isOTShift,
      shift_name: shiftName
    };
  }

  /**
   * Main entry point: Handle a new punch
   */
  async handlePunch(employeeId, employeeType, timestampStr, date, location) {
    const currentPunchTime = new Date(timestampStr);

    // Step 1: Get last punch
    const lastPunch = await this.getLastPunch(employeeId, date);

    // Step 2: Check for duplicate
    if (lastPunch && lastPunch.lastPunchTime) {
      if (this.isDuplicatePunch(lastPunch.lastPunchTime, currentPunchTime)) {
        console.log(
          `[PUNCH-HANDLER] Duplicate punch ignored for employee ${employeeId}: ` +
          `last punch at ${lastPunch.lastPunchTime.toISOString()}, ` +
          `current at ${currentPunchTime.toISOString()}`
        );
        return {
          handled: false,
          reason: 'duplicate',
          message: 'Duplicate punch ignored (within duplicate window)'
        };
      }
    }

    // Step 3: Determine punch type (IN or OUT)
    const punchType = await this.determinePunchType(employeeId, date);

    // Step 4: Process based on type
    if (punchType.type === 'OUT') {
      const result = await this.processCheckOut(
        punchType.openSession,
        employeeId,
        employeeType,
        timestampStr,
        date,
        location
      );
      return {
        handled: true,
        type: 'OUT',
        ...result
      };
    } else {
      const result = await this.processCheckIn(
        employeeId,
        employeeType,
        timestampStr,
        date,
        location
      );
      return {
        handled: true,
        type: 'IN',
        ...result
      };
    }
  }
}

const punchHandlingService = new PunchHandlingService();

module.exports = {
  handlePunch: (employeeId, employeeType, timestampStr, date, location) =>
    punchHandlingService.handlePunch(employeeId, employeeType, timestampStr, date, location),
  getLastPunch: (employeeId, date) =>
    punchHandlingService.getLastPunch(employeeId, date),
  isDuplicatePunch: (lastPunchTime, currentPunchTime) =>
    punchHandlingService.isDuplicatePunch(lastPunchTime, currentPunchTime)
};

