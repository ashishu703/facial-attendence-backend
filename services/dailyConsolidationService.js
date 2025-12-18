/**
 * Daily Consolidation Service
 * 
 * Consolidates multiple attendance sessions per employee per day into
 * a single effective IN/OUT with calculated status (Full Day / Half Day / Short / Absent).
 * 
 * This service:
 * 1. Aggregates all valid sessions for an employee on a date
 * 2. Calculates effective IN/OUT times
 * 3. Computes total working hours
 * 4. Determines attendance status
 * 5. Flags missing punches
 * 
 * Cross-Midnight Shift Support: For future enhancement, consolidation can be 
 * extended to look across two calendar dates when handling night shifts 
 * (e.g., 22:00–06:00). Current design is already compatible with that.
 */

const db = require('../config/db');
const attendanceConfig = require('./attendanceConfigService');
const {
  getAllShifts,
  detectShiftForTime,
  buildLocalTime,
  buildShiftEndTime
} = require('./attendanceLogicService');

class DailyConsolidationService {
  constructor() {
    this.config = attendanceConfig;
  }

  /**
   * Consolidate attendance for a single employee on a specific date
   */
  async consolidateEmployeeDate(employeeId, date) {
    try {
      // Get all attendance records for this employee on this date
      const { rows: records } = await db.query(
        `SELECT r.*, d.employee_type
         FROM attendance_records r
         JOIN employee_details d ON r.employee_id = d.employee_id
         WHERE r.employee_id = $1 AND r.attendance_date = $2
         ORDER BY r.in_time ASC`,
        [employeeId, date]
      );

      if (records.length === 0) {
        // No records - employee is absent
        return {
          employee_id: employeeId,
          attendance_date: date,
          effective_in_time: null,
          effective_out_time: null,
          total_work_hours: 0,
          delay_by_minutes: 0,
          extra_time_minutes: 0,
          ot_hours_decimal: 0,
          status: 'Absent',
          missing_punch: false,
          valid_sessions_count: 0
        };
      }

      // Filter to only valid sessions (has both IN and OUT, and is_valid_session = true)
      const validSessions = records.filter(r => 
        r.in_time && 
        r.out_time && 
        (r.is_valid_session === true || r.is_valid_session === null) // null = legacy records, assume valid
      );

      if (validSessions.length === 0) {
        // Has records but no valid sessions (check-in but no checkout)
        const hasIncompleteSession = records.some(r => r.in_time && !r.out_time);
        const hasCheckIn = records.some(r => r.in_time);
        
        // If no check-in at all, employee is absent
        if (!hasCheckIn) {
          return {
            employee_id: employeeId,
            attendance_date: date,
            effective_in_time: null,
            effective_out_time: null,
            total_work_hours: 0,
            delay_by_minutes: 0,
            extra_time_minutes: 0,
            ot_hours_decimal: 0,
            status: 'Absent',
            missing_punch: false,
            valid_sessions_count: 0
          };
        }
        
        // Employee has check-in but no checkout
        // Rule: Mark as "Absent" and keep checkout as null (Not checked out)
        const firstCheckIn = records.find(r => r.in_time)?.in_time;
        if (!firstCheckIn) {
          return {
            employee_id: employeeId,
            attendance_date: date,
            effective_in_time: null,
            effective_out_time: null,
            total_work_hours: 0,
            delay_by_minutes: 0,
            extra_time_minutes: 0,
            ot_hours_decimal: 0,
            status: 'Absent',
            missing_punch: false,
            valid_sessions_count: 0
          };
        }
        
        const inTime = new Date(firstCheckIn);
        const employeeType = records[0].employee_type;
        const shifts = await getAllShifts(employeeType);
        
        // Calculate delay only
        let delayByMinutes = 0;
        
        if (shifts.length > 0) {
          const detectedShift = detectShiftForTime(inTime, shifts);
          const shift = detectedShift?.shift || shifts[0];
          
          // Build shift start time on the same date as check-in
          const checkInDate = new Date(inTime);
          checkInDate.setHours(0, 0, 0, 0);
          
          const shiftStartOnDate = new Date(checkInDate);
          shiftStartOnDate.setHours(shift.startHour, shift.startMinute, 0, 0);
          
          // Calculate delay: shiftStartTime - checkInTime (no negative values)
          // If check-in is before shift start, delay = 0
          const inTimeMs = inTime.getTime();
          const shiftStartMs = shiftStartOnDate.getTime();
          
          if (inTimeMs > shiftStartMs) {
            // Check-in is after shift start - calculate delay
            delayByMinutes = Math.max(0, Math.round((inTimeMs - shiftStartMs) / (1000 * 60)));
          } else {
            // Check-in is before or on time - no delay
            delayByMinutes = 0;
          }
        }
        
        // Mark as Absent when checkout is missing
        return {
          employee_id: employeeId,
          attendance_date: date,
          effective_in_time: firstCheckIn,
          effective_out_time: null, // Not checked out
          total_work_hours: 0,
          delay_by_minutes: delayByMinutes,
          extra_time_minutes: 0,
          ot_hours_decimal: 0,
          status: 'Absent', // Mark as Absent when checkout is missing
          missing_punch: true,
          valid_sessions_count: 0
        };
      }

      // Calculate total working minutes from all valid sessions
      let totalWorkMinutes = 0;
      let totalOTMinutes = 0;

      for (const session of validSessions) {
        const inTime = new Date(session.in_time);
        const outTime = new Date(session.out_time);
        const sessionMinutes = Math.round((outTime.getTime() - inTime.getTime()) / (1000 * 60));
        totalWorkMinutes += sessionMinutes;
        
        // Sum OT hours (convert to minutes)
        if (session.ot_hours_decimal) {
          totalOTMinutes += Math.round(session.ot_hours_decimal * 60);
        }
      }

      // Clamp total work hours to MAX_DAY_DURATION_HOURS
      const totalWorkHours = Math.min(
        totalWorkMinutes / 60,
        this.config.MAX_DAY_DURATION_HOURS
      );

      const effectiveInTime = validSessions[0].in_time; 
      const effectiveOutTime = validSessions[validSessions.length - 1].out_time; 

      const employeeType = validSessions[0].employee_type;
      const shifts = await getAllShifts(employeeType);
      
      let delayByMinutes = 0;
      let extraTimeMinutes = 0;

      if (shifts.length > 0 && effectiveInTime) {
        const inTime = new Date(effectiveInTime);
        const outTime = effectiveOutTime ? new Date(effectiveOutTime) : null;
        const detectedShift = detectShiftForTime(inTime, shifts);
        const shift = detectedShift?.shift || shifts[0];

        // Build shift start time on the same date as check-in
        const shiftStartTime = buildLocalTime(inTime, shift.startHour, shift.startMinute);
        const shiftEndTime = buildShiftEndTime(inTime, shift);

        // Ensure both times are on the same date for accurate comparison
        // Get the date part from check-in time
        const checkInDate = new Date(inTime);
        checkInDate.setHours(0, 0, 0, 0);
        
        const shiftStartOnDate = new Date(checkInDate);
        shiftStartOnDate.setHours(shift.startHour, shift.startMinute, 0, 0);
        
        // Calculate delay: shiftStartTime - checkInTime (no negative values)
        // If check-in is before shift start, delay = 0
        const inTimeMs = inTime.getTime();
        const shiftStartMs = shiftStartOnDate.getTime();
        
        if (inTimeMs > shiftStartMs) {
          // Check-in is after shift start - calculate delay
          delayByMinutes = Math.max(0, Math.round((inTimeMs - shiftStartMs) / (1000 * 60)));
        } else {
          // Check-in is before or on time - no delay
          delayByMinutes = 0;
        }

        // Calculate extra time: shiftEndTime - checkOutTime (no negative values)
        // If check-out is before shift end, extra time = 0
        if (outTime) {
          const outTimeMs = outTime.getTime();
          const shiftEndMs = shiftEndTime.getTime();
          
          if (outTimeMs > shiftEndMs) {
            // Check-out is after shift end - calculate extra time
            extraTimeMinutes = Math.max(0, Math.round((outTimeMs - shiftEndMs) / (1000 * 60)));
          } else {
            // Check-out is before or on time - no extra time
            extraTimeMinutes = 0;
          }
        }
      }

      // Calculate OT hours (from total OT minutes)
      const otHoursDecimal = parseFloat((totalOTMinutes / 60).toFixed(2));

      // Check for missing punch (only if shift has ended and checkout is missing)
      const hasIncompleteSession = records.some(r => r.in_time && !r.out_time);
      let missingPunch = false;
      
      // Only mark as missing punch if shift has ended and checkout is missing
      if (hasIncompleteSession && effectiveInTime) {
        const employeeType = validSessions[0]?.employee_type || records[0]?.employee_type;
        const shifts = await getAllShifts(employeeType);
        if (shifts.length > 0) {
          const inTime = new Date(effectiveInTime);
          const detectedShift = detectShiftForTime(inTime, shifts);
          const shift = detectedShift?.shift || shifts[0];
          const shiftEndTime = buildShiftEndTime(inTime, shift);
          const now = new Date();
          
          // Missing punch only if shift has ended and checkout is still missing
          missingPunch = now.getTime() > shiftEndTime.getTime() && !effectiveOutTime;
        }
      }

      // Determine status based on total work hours
      // Note: If there are valid sessions, effectiveOutTime will always be set
      // If there are no valid sessions, we already returned "Absent" earlier
      let status = 'Absent';
      if (totalWorkHours >= this.config.FULL_DAY_THRESHOLD_HOURS) {
        status = 'Full Day';
      } else if (totalWorkHours >= this.config.HALF_DAY_THRESHOLD_HOURS) {
        status = 'Half Day';
      } else if (totalWorkHours > 0) {
        status = 'Short';
      }
      // Note: If totalWorkHours is 0 and we have valid sessions, it means all sessions were invalid
      // In that case, status remains 'Absent' which is correct

      return {
        employee_id: employeeId,
        attendance_date: date,
        effective_in_time: effectiveInTime,
        effective_out_time: effectiveOutTime,
        total_work_hours: parseFloat(totalWorkHours.toFixed(2)),
        delay_by_minutes: delayByMinutes,
        extra_time_minutes: extraTimeMinutes,
        ot_hours_decimal: otHoursDecimal,
        status: status,
        missing_punch: missingPunch,
        valid_sessions_count: validSessions.length
      };
    } catch (error) {
      console.error(`[CONSOLIDATION] Error consolidating employee ${employeeId} for date ${date}:`, error);
      throw error;
    }
  }

  /**
   * Consolidate attendance for all employees on a specific date
   */
  async consolidateDate(date) {
    try {
      console.log(`[CONSOLIDATION] Consolidating attendance for date: ${date}`);

      // Ensure is_active column exists
      await db.query(`ALTER TABLE employee_details ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;`);

      // Get all unique employees who have records on this date
      const { rows: employees } = await db.query(
        `SELECT DISTINCT r.employee_id 
         FROM attendance_records r
         JOIN employee_details d ON r.employee_id = d.employee_id
         WHERE r.attendance_date = $1 AND COALESCE(d.is_active, true) = true`,
        [date]
      );

      // Also get all active employees (to mark absent ones)
      const { rows: allEmployees } = await db.query(
        `SELECT employee_id FROM employee_details WHERE COALESCE(is_active, true) = true`
      );

      const allEmployeeIds = new Set([
        ...employees.map(e => e.employee_id),
        ...allEmployees.map(e => e.employee_id)
      ]);

      const results = [];

      for (const employeeId of allEmployeeIds) {
        const consolidated = await this.consolidateEmployeeDate(employeeId, date);
        results.push(consolidated);
      }

      console.log(`[CONSOLIDATION] Consolidated ${results.length} employee records for date: ${date}`);

      return results;
    } catch (error) {
      console.error(`[CONSOLIDATION] Error consolidating date ${date}:`, error);
      throw error;
    }
  }

  /**
   * Consolidate yesterday's attendance (main entry point for daily job)
   */
  async consolidateYesterday() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    return await this.consolidateDate(dateStr);
  }

  /**
   * Consolidate today's attendance (for manual/admin trigger)
   */
  async consolidateToday() {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];

    return await this.consolidateDate(dateStr);
  }
}

const dailyConsolidationService = new DailyConsolidationService();

module.exports = {
  consolidateEmployeeDate: (employeeId, date) => 
    dailyConsolidationService.consolidateEmployeeDate(employeeId, date),
  consolidateDate: (date) => 
    dailyConsolidationService.consolidateDate(date),
  consolidateYesterday: () => 
    dailyConsolidationService.consolidateYesterday(),
  consolidateToday: () => 
    dailyConsolidationService.consolidateToday()
};

