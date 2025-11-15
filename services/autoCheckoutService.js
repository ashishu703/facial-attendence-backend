const db = require('../config/db');
const { getAllShifts, detectShiftForTime, getShiftEndWithGrace } = require('./attendanceLogicService');
const { calculateAttendanceMetrics } = require('./attendanceLogicService');

async function autoCheckoutOverdue() {
  try {
    const { rows } = await db.query(`
      SELECT r.attendance_id, r.employee_id, r.attendance_date, r.in_time::text AS in_time,
             d.employee_type
      FROM attendance_records r
      JOIN employee_details d ON r.employee_id = d.employee_id
      WHERE r.out_time IS NULL
    `);
    const now = new Date();
    for (const row of rows) {
      const inTime = new Date(row.in_time);
      const shifts = await getAllShifts(row.employee_type);
      if (!shifts.length) continue;
      const detected = detectShiftForTime(inTime, shifts);
      const shift = detected?.shift || shifts[0];
      const endWithGrace = getShiftEndWithGrace(inTime, shift);
      if (now.getTime() >= endWithGrace.getTime()) {
        const outISO = endWithGrace.toISOString();
        const metrics = await calculateAttendanceMetrics(row.in_time, outISO, row.employee_type, false);
        await db.query(
          `UPDATE attendance_records
           SET out_time = $1::timestamp, delay_by_minutes=$2, extra_time_minutes=$3, total_working_hours_decimal=$4
           WHERE attendance_id=$5`,
          [outISO, metrics.delay_by_minutes, metrics.extra_time_minutes, metrics.total_working_hours_decimal, row.attendance_id]
        );
      }
    }
  } catch (e) {
    console.error('autoCheckoutOverdue error:', e);
  }
}

module.exports = { autoCheckoutOverdue };


