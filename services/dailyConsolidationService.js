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
        
        // Employee has check-in but no checkout - calculate partial hours
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
        
        // Calculate delay
        let delayByMinutes = 0;
        let shiftEndTime = null;
        let currentTime = new Date();
        let partialHours = 0;
        let status = 'Short';
        
        if (shifts.length > 0) {
          const detectedShift = detectShiftForTime(inTime, shifts);
          const shift = detectedShift?.shift || shifts[0];
          const shiftStartTime = buildLocalTime(inTime, shift.startHour, shift.startMinute);
          shiftEndTime = buildShiftEndTime(inTime, shift);
          
          // Calculate delay
          if (inTime.getTime() > shiftStartTime.getTime()) {
            delayByMinutes = Math.round((inTime.getTime() - shiftStartTime.getTime()) / (1000 * 60));
          }
          
          // Calculate partial hours: from check-in to now (or shift end, whichever is earlier)
          // This gives us hours worked so far
          const endTimeForCalculation = currentTime.getTime() < shiftEndTime.getTime() 
            ? currentTime 
            : shiftEndTime;
          
          partialHours = Math.max(0, (endTimeForCalculation.getTime() - inTime.getTime()) / (1000 * 60 * 60));
          partialHours = Math.min(partialHours, this.config.MAX_DAY_DURATION_HOURS);
          
          // Determine status based on partial hours
          if (partialHours >= this.config.FULL_DAY_THRESHOLD_HOURS) {
            status = 'Full Day';
          } else if (partialHours >= this.config.HALF_DAY_THRESHOLD_HOURS) {
            status = 'Half Day';
          } else if (partialHours > 0) {
            status = 'Short';
          }
          
          // Only mark as "Missing Punch" if shift has ended and they forgot checkout
          const now = new Date();
          if (now.getTime() > shiftEndTime.getTime()) {
            // Shift has ended - they forgot to checkout
            status = 'Missing Punch';
          }
        } else {
          // No shift settings - calculate from check-in to now
          partialHours = Math.max(0, (currentTime.getTime() - inTime.getTime()) / (1000 * 60 * 60));
          partialHours = Math.min(partialHours, this.config.MAX_DAY_DURATION_HOURS);
          
          if (partialHours >= this.config.FULL_DAY_THRESHOLD_HOURS) {
            status = 'Full Day';
          } else if (partialHours >= this.config.HALF_DAY_THRESHOLD_HOURS) {
            status = 'Half Day';
          } else if (partialHours > 0) {
            status = 'Short';
          }
        }
        
        return {
          employee_id: employeeId,
          attendance_date: date,
          effective_in_time: firstCheckIn,
          effective_out_time: null,
          total_work_hours: parseFloat(partialHours.toFixed(2)),
          delay_by_minutes: delayByMinutes,
          extra_time_minutes: 0,
          ot_hours_decimal: 0,
          status: status,
          missing_punch: hasIncompleteSession && shiftEndTime && new Date().getTime() > shiftEndTime.getTime(),
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

      // Get effective IN/OUT times
      const effectiveInTime = validSessions[0].in_time; // Earliest IN
      const effectiveOutTime = validSessions[validSessions.length - 1].out_time; // Latest OUT

      // Calculate delay and extra time based on effective times and shift settings
      const employeeType = validSessions[0].employee_type;
      const shifts = await getAllShifts(employeeType);
      
      let delayByMinutes = 0;
      let extraTimeMinutes = 0;

      if (shifts.length > 0 && effectiveInTime) {
        const inTime = new Date(effectiveInTime);
        const outTime = effectiveOutTime ? new Date(effectiveOutTime) : null;
        const detectedShift = detectShiftForTime(inTime, shifts);
        const shift = detectedShift?.shift || shifts[0];

        const shiftStartTime = buildLocalTime(inTime, shift.startHour, shift.startMinute);
        const shiftEndTime = buildShiftEndTime(inTime, shift);

        // Calculate delay based on shift start time
        // Delay = Check-in time - Shift start time (if check-in is after shift start)
        if (inTime.getTime() > shiftStartTime.getTime()) {
          delayByMinutes = Math.round((inTime.getTime() - shiftStartTime.getTime()) / (1000 * 60));
        }

        // Calculate extra time based on shift end time
        // Extra time = Check-out time - Shift end time (if check-out is after shift end)
        if (outTime && outTime.getTime() > shiftEndTime.getTime()) {
          extraTimeMinutes = Math.round((outTime.getTime() - shiftEndTime.getTime()) / (1000 * 60));
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
      let status = 'Absent';
      if (totalWorkHours >= this.config.FULL_DAY_THRESHOLD_HOURS) {
        status = 'Full Day';
      } else if (totalWorkHours >= this.config.HALF_DAY_THRESHOLD_HOURS) {
        status = 'Half Day';
      } else if (totalWorkHours > 0) {
        status = 'Short';
      } else if (effectiveInTime && !effectiveOutTime) {
        // Has check-in but no checkout - check if shift ended
        const employeeType = validSessions[0]?.employee_type || records[0]?.employee_type;
        const shifts = await getAllShifts(employeeType);
        if (shifts.length > 0) {
          const inTime = new Date(effectiveInTime);
          const detectedShift = detectShiftForTime(inTime, shifts);
          const shift = detectedShift?.shift || shifts[0];
          const shiftEndTime = buildShiftEndTime(inTime, shift);
          const now = new Date();
          
          if (now.getTime() > shiftEndTime.getTime()) {
            status = 'Missing Punch'; // Shift ended, forgot checkout
          } else {
            status = 'Short'; // Still working, show partial status
          }
        } else {
          status = 'Short'; // No shift settings, show partial
        }
      }

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

      // Get all unique employees who have records on this date
      const { rows: employees } = await db.query(
        `SELECT DISTINCT employee_id 
         FROM attendance_records 
         WHERE attendance_date = $1`,
        [date]
      );

      // Also get all employees (to mark absent ones)
      const { rows: allEmployees } = await db.query(
        `SELECT employee_id FROM employee_details`
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

