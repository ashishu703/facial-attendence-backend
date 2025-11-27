const express = require('express');
const exceljs = require('exceljs');
const db = require('../config/db');
const { 
  calculateAttendanceMetrics,
  getAllShifts,
  detectShiftForTime,
  buildLocalTime,
  buildShiftEndTime
} = require('../services/attendanceLogicService');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Ensure edit-tracking columns and OT column exist on attendance_records
let editColumnsEnsured = false;
async function ensureEditColumns() {
  if (editColumnsEnsured) return;
  try {
    await db.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS is_edited boolean DEFAULT false');
    await db.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS edit_remark text');
    await db.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS edited_at timestamptz');
    await db.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS ot_hours_decimal numeric(10,2) DEFAULT 0');
  } catch (err) {
    console.error('Error ensuring edit columns on attendance_records:', err);
  } finally {
    editColumnsEnsured = true;
  }
}

// Helper: recalculate metrics for an attendance record and persist them
async function recalculateAndUpdateAttendanceRecord(
  attendanceId,
  employeeType,
  attendanceDate,
  inTimeStr,
  outTimeStr,
  locationIn,
  locationOut,
  editOptions = {}
) {
  await ensureEditColumns();

  const hasOutTime = !!outTimeStr;
  const manuallySetOT = editOptions.ot_hours_decimal !== undefined && editOptions.ot_hours_decimal !== null;

  let metrics = {
    delay_by_minutes: 0,
    extra_time_minutes: 0,
    total_working_hours_decimal: 0,
    ot_hours_decimal: 0
  };

  if (hasOutTime) {
    // Calculate base metrics (delay, extra time, etc.)
    metrics = await calculateAttendanceMetrics(inTimeStr, outTimeStr, employeeType, false);
    
    // Calculate regular shift hours
    const shifts = await getAllShifts(employeeType);
    let regularShiftHours = 0;
    
    if (shifts.length > 0) {
      const inTime = new Date(inTimeStr);
      const outTime = new Date(outTimeStr);
      const detectedShift = detectShiftForTime(inTime, shifts);
      const shift = detectedShift?.shift || shifts[0];
      const shiftStartTime = buildLocalTime(inTime, shift.startHour, shift.startMinute);
      const shiftEndTime = buildShiftEndTime(inTime, shift);
      
      // Regular shift hours calculation:
      // - If checkout >= shift end: regularShiftHours = shift end - shift start
      // - If checkout < shift end: regularShiftHours = checkout - shift start
      if (outTime.getTime() >= shiftEndTime.getTime()) {
        regularShiftHours = Math.max(0, parseFloat(((shiftEndTime.getTime() - shiftStartTime.getTime()) / (1000 * 60 * 60)).toFixed(2)));
      } else {
        regularShiftHours = Math.max(0, parseFloat(((outTime.getTime() - shiftStartTime.getTime()) / (1000 * 60 * 60)).toFixed(2)));
      }
    }
    
    // If OT is manually set, use it; otherwise use calculated OT
    if (manuallySetOT) {
      const manualOT = Math.max(0, parseFloat(editOptions.ot_hours_decimal) || 0);
      metrics.ot_hours_decimal = manualOT;
      
      // When manual OT is set: Total = Actual Worked Hours (checkout - checkin) + Manual OT
      // This handles cases where employee worked extra hours beyond their shift
      metrics.total_working_hours_decimal = Math.max(0, parseFloat((metrics.total_working_hours_decimal + manualOT).toFixed(2)));
    } else {
      // No manual OT: Use existing logic (regular shift hours + auto-calculated OT)
      if (metrics.ot_hours_decimal > 0) {
        metrics.total_working_hours_decimal = Math.max(0, parseFloat((regularShiftHours + metrics.ot_hours_decimal).toFixed(2)));
      }
      // If no OT, metrics.total_working_hours_decimal already has the correct value (checkout - checkin)
    }
  } else if (inTimeStr && employeeType) {
    // When there is no checkout yet, at least compute delay_by_minutes from shift start
    const shifts = await getAllShifts(employeeType);
    if (shifts.length > 0) {
      const inTime = new Date(inTimeStr);
      const detectedShift = detectShiftForTime(inTime, shifts);
      const shift = detectedShift?.shift || shifts[0];
      const shiftStart = buildLocalTime(inTime, shift.startHour, shift.startMinute);
      if (inTime.getTime() > shiftStart.getTime()) {
        metrics.delay_by_minutes = Math.round((inTime.getTime() - shiftStart.getTime()) / (1000 * 60));
      }
    }
  }

  const markEdited = !!editOptions.markEdited;
  const editRemark = editOptions.editRemark ? String(editOptions.editRemark) : null;
  const editedAt = markEdited ? new Date().toISOString() : null;

  await db.query(
    `UPDATE attendance_records
     SET attendance_date = $1,
         in_time = $2::timestamp,
         out_time = $3::timestamp,
         location_in = $4,
         location_out = $5,
         delay_by_minutes = $6,
         extra_time_minutes = $7,
         total_working_hours_decimal = $8,
         ot_hours_decimal = $9,
         is_edited = COALESCE($10, is_edited),
         edit_remark = COALESCE($11, edit_remark),
         edited_at = COALESCE($12::timestamptz, edited_at)
     WHERE attendance_id = $13`,
    [
      attendanceDate,
      inTimeStr,
      hasOutTime ? outTimeStr : null,
      locationIn,
      locationOut,
      metrics.delay_by_minutes,
      metrics.extra_time_minutes,
      metrics.total_working_hours_decimal,
      metrics.ot_hours_decimal,
      markEdited ? true : null,
      editRemark,
      editedAt,
      attendanceId
    ]
  );

  return metrics;
}

async function fetchAttendanceRows(startDate, endDate) {
  await ensureEditColumns();
  
  let query = `SELECT COALESCE(d.employee_code, d.employee_id::text) AS employee_code,
    d.employee_name, d.employee_type, r.attendance_date, r.in_time::text AS in_time,
    CASE WHEN r.out_time IS NOT NULL THEN r.out_time::text ELSE NULL END AS out_time,
    r.delay_by_minutes, r.extra_time_minutes, r.total_working_hours_decimal,
    COALESCE(r.ot_hours_decimal, 0) as ot_hours_decimal,
    r.location_in, r.location_out, r.attendance_id, r.employee_id
    FROM attendance_records r JOIN employee_details d ON r.employee_id = d.employee_id`;
  const params = [];
  if (startDate && endDate) {
    params.push(startDate, endDate);
    query += ' WHERE r.attendance_date BETWEEN $1 AND $2';
  }
  query += ' ORDER BY r.attendance_date DESC, d.employee_name, r.in_time ASC';
  const { rows } = await db.query(query, params);
  
  const employeeDateMap = {};
  rows.forEach(row => {
    const key = `${row.employee_id}_${row.attendance_date}`;
    if (!employeeDateMap[key]) employeeDateMap[key] = [];
    employeeDateMap[key].push(row);
  });
  
  const processedRows = await Promise.all(rows.map(async (row) => {
    const key = `${row.employee_id}_${row.attendance_date}`;
    const recordsForDay = employeeDateMap[key];
    const currentRecordIndex = recordsForDay.findIndex(r => r.attendance_id === row.attendance_id);
    const isOTShift = currentRecordIndex > 0 && row.out_time !== null;
    
    const dbOTHours = parseFloat(row.ot_hours_decimal) || 0;
    
    let metrics = {
      delay_by_minutes: row.delay_by_minutes || 0,
      extra_time_minutes: row.extra_time_minutes || 0,
      total_working_hours_decimal: row.total_working_hours_decimal || 0,
      ot_hours_decimal: dbOTHours
    };
    
    if (row.out_time && row.in_time && row.employee_type) {
      const recalculated = await calculateAttendanceMetrics(row.in_time, row.out_time, row.employee_type, isOTShift);
      
      // Calculate regular shift hours
      const shifts = await getAllShifts(row.employee_type);
      let regularShiftHours = 0;
      
      if (shifts.length > 0) {
        const inTime = new Date(row.in_time);
        const outTime = new Date(row.out_time);
        const detectedShift = detectShiftForTime(inTime, shifts);
        const shift = detectedShift?.shift || shifts[0];
        const shiftStartTime = buildLocalTime(inTime, shift.startHour, shift.startMinute);
        const shiftEndTime = buildShiftEndTime(inTime, shift);
        
        // Regular shift hours calculation:
        // - If checkout >= shift end: regularShiftHours = shift end - shift start
        // - If checkout < shift end: regularShiftHours = checkout - shift start
        if (outTime.getTime() >= shiftEndTime.getTime()) {
          regularShiftHours = Math.max(0, parseFloat(((shiftEndTime.getTime() - shiftStartTime.getTime()) / (1000 * 60 * 60)).toFixed(2)));
        } else {
          regularShiftHours = Math.max(0, parseFloat(((outTime.getTime() - shiftStartTime.getTime()) / (1000 * 60 * 60)).toFixed(2)));
        }
      }
      
      // Use DB OT if exists (manually set), otherwise use calculated
      const finalOTHours = dbOTHours > 0 ? dbOTHours : (recalculated.ot_hours_decimal || 0);
      
      // Total hours calculation:
      // - If manual OT is set: Total = Actual Worked Hours (checkout - checkin) + Manual OT
      // - If auto-calculated OT exists: Total = Regular Shift Hours + Auto OT
      // - If no OT: Total = Actual Worked Hours (checkout - checkin)
      let finalTotalHours;
      if (dbOTHours > 0) {
        // Manual OT: Add to actual worked hours
        finalTotalHours = Math.max(0, parseFloat((recalculated.total_working_hours_decimal + dbOTHours).toFixed(2)));
      } else if (finalOTHours > 0) {
        // Auto-calculated OT: Add to regular shift hours
        finalTotalHours = Math.max(0, parseFloat((regularShiftHours + finalOTHours).toFixed(2)));
      } else {
        // No OT: Use actual worked hours
        finalTotalHours = recalculated.total_working_hours_decimal;
      }
      
      metrics = {
        delay_by_minutes: recalculated.delay_by_minutes,
        extra_time_minutes: recalculated.extra_time_minutes,
        total_working_hours_decimal: finalTotalHours,
        ot_hours_decimal: finalOTHours
      };
    }
    
    return {
      ...row,
      in_time: row.in_time ? new Date(row.in_time).toISOString() : null,
      out_time: row.out_time ? new Date(row.out_time).toISOString() : null,
      ...metrics,
      is_ot: isOTShift
    };
  }));
  
  return processedRows;
}

// ========== Admin APIs for manual edit/delete (used by ViewReports) ==========

// Fallback update when old report data does not include attendance_id
router.put('/by-keys/update', protect, async (req, res) => {
  const {
    employee_code,
    attendance_date,
    in_time,
    out_time,
    location_in,
    location_out,
    edit_remark,
    ot_hours_decimal,
  } = req.body;

  if (!employee_code || !attendance_date || !in_time) {
    return res.status(400).json({
      message: 'employee_code, attendance_date and in_time are required to locate the record.'
    });
  }

  try {
    const lookupRes = await db.query(
      `SELECT ar.attendance_id, ar.attendance_date, ar.in_time, ar.out_time,
              ar.location_in, ar.location_out, e.employee_type
       FROM attendance_records ar
       JOIN employee_details e ON e.employee_id = ar.employee_id
       WHERE e.employee_code = $1
         AND ar.attendance_date = $2
         AND ar.in_time = $3`,
      [employee_code, attendance_date, in_time]
    );

    if (lookupRes.rows.length === 0) {
      return res.status(404).json({ message: 'Attendance record not found for given keys.' });
    }

    const existing = lookupRes.rows[0];

    const newAttendanceDate = attendance_date || existing.attendance_date;
    const newInTime = in_time || existing.in_time;
    const newOutTime = out_time || existing.out_time;
    const newLocationIn = typeof location_in === 'string' ? location_in : existing.location_in;
    const newLocationOut = typeof location_out === 'string' || location_out === null
      ? location_out
      : existing.location_out;

    await recalculateAndUpdateAttendanceRecord(
      existing.attendance_id,
      existing.employee_type,
      newAttendanceDate,
      newInTime,
      newOutTime,
      newLocationIn,
      newLocationOut,
      {
        markEdited: !!edit_remark,
        editRemark: edit_remark,
        ot_hours_decimal: ot_hours_decimal !== undefined ? parseFloat(ot_hours_decimal) : undefined,
      }
    );

    return res.json({ message: 'Attendance record updated successfully (by keys).' });
  } catch (error) {
    console.error('Error updating attendance record by keys:', error);
    return res.status(500).json({ message: 'Server error updating attendance record by keys.' });
  }
});

// Fallback delete when old report data does not include attendance_id
router.delete('/by-keys/delete', protect, async (req, res) => {
  const {
    employee_code,
    attendance_date,
    in_time,
  } = req.body || req.query || {};

  if (!employee_code || !attendance_date || !in_time) {
    return res.status(400).json({
      message: 'employee_code, attendance_date and in_time are required to locate the record.'
    });
  }

  try {
    const deleteRes = await db.query(
      `DELETE FROM attendance_records
       USING employee_details
       WHERE attendance_records.employee_id = employee_details.employee_id
         AND employee_details.employee_code = $1
         AND attendance_records.attendance_date = $2
         AND attendance_records.in_time = $3`,
      [employee_code, attendance_date, in_time]
    );

    if (deleteRes.rowCount === 0) {
      return res.status(404).json({ message: 'Attendance record not found for given keys.' });
    }

    return res.json({ message: 'Attendance record deleted successfully (by keys).' });
  } catch (error) {
    console.error('Error deleting attendance record by keys:', error);
    return res.status(500).json({ message: 'Server error deleting attendance record by keys.' });
  }
});

// Update attendance by ID (preferred path when attendance_id is known)
router.put('/:id', protect, async (req, res) => {
  const { id } = req.params;
  const {
    attendance_date,
    in_time,
    out_time,
    location_in,
    location_out,
    edit_remark,
    ot_hours_decimal,
  } = req.body;

  if (!attendance_date && !in_time && !out_time && !location_in && !location_out && ot_hours_decimal === undefined) {
    return res.status(400).json({ message: 'No fields provided to update.' });
  }

  try {
    const existingRes = await db.query(
      `SELECT ar.attendance_id, ar.attendance_date, ar.in_time, ar.out_time,
              ar.location_in, ar.location_out, e.employee_type
       FROM attendance_records ar
       JOIN employee_details e ON e.employee_id = ar.employee_id
       WHERE ar.attendance_id = $1`,
      [id]
    );

    if (existingRes.rows.length === 0) {
      return res.status(404).json({ message: 'Attendance record not found.' });
    }

    const existing = existingRes.rows[0];

    const newAttendanceDate = attendance_date || existing.attendance_date;
    const newInTime = in_time || existing.in_time;
    const newOutTime = out_time || existing.out_time;
    const newLocationIn = typeof location_in === 'string' ? location_in : existing.location_in;
    const newLocationOut = typeof location_out === 'string' || location_out === null
      ? location_out
      : existing.location_out;

    await recalculateAndUpdateAttendanceRecord(
      existing.attendance_id,
      existing.employee_type,
      newAttendanceDate,
      newInTime,
      newOutTime,
      newLocationIn,
      newLocationOut,
      {
        markEdited: !!edit_remark,
        editRemark: edit_remark,
        ot_hours_decimal: ot_hours_decimal !== undefined ? parseFloat(ot_hours_decimal) : undefined,
      }
    );

    return res.json({ message: 'Attendance record updated successfully.' });
  } catch (error) {
    console.error('Error updating attendance record by ID:', error);
    return res.status(500).json({ message: 'Server error updating attendance record.' });
  }
});

// Delete attendance by ID
router.delete('/:id', protect, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      'DELETE FROM attendance_records WHERE attendance_id = $1',
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Attendance record not found.' });
    }

    return res.json({ message: 'Attendance record deleted successfully.' });
  } catch (error) {
    console.error('Error deleting attendance record by ID:', error);
    return res.status(500).json({ message: 'Server error deleting attendance record.' });
  }
});

router.get('/report', protect, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const rows = await fetchAttendanceRows(startDate, endDate);
    res.json(rows);
  } catch (error) {
    console.error('Report error:', error);
    res.status(500).json({ message: 'Server error fetching report.' });
  }
});

router.get('/download-excel', protect, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const rows = await fetchAttendanceRows(startDate, endDate);

    const workbook = new exceljs.Workbook();
    const worksheet = workbook.addWorksheet('Attendance Report');

    worksheet.columns = [
      { header: 'Employee Code', key: 'employee_code', width: 16 },
      { header: 'Employee Name', key: 'employee_name', width: 20 },
      { header: 'Employee Type', key: 'employee_type', width: 15 },
      { header: 'Attendance Date', key: 'attendance_date', width: 15 },
      { header: 'Check-in Time', key: 'in_time', width: 20 },
      { header: 'Check-out Time', key: 'out_time', width: 20 },
      { header: 'Delay (minutes)', key: 'delay_by_minutes', width: 15 },
      { header: 'Extra Time (minutes)', key: 'extra_time_minutes', width: 18 },
      { header: 'Total Hours', key: 'total_working_hours_decimal', width: 12 },
      { header: 'OT Hours', key: 'ot_hours_decimal', width: 12 },
      { header: 'Shift Type', key: 'shift_type', width: 12 },
      { header: 'Location (In)', key: 'location_in', width: 20 },
      { header: 'Location (Out)', key: 'location_out', width: 20 },
    ];

    const excelData = rows.map(row => ({
      ...row,
      attendance_date: new Date(row.attendance_date),
      in_time: row.in_time ? new Date(row.in_time) : null,
      out_time: row.out_time ? new Date(row.out_time) : null,
      shift_type: row.is_ot ? 'OT' : 'Regular',
      ot_hours_decimal: row.ot_hours_decimal || 0,
    }));
    worksheet.addRows(excelData);

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="attendance_report.xlsx"'
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Excel download error:', error);
    res.status(500).json({ message: 'Server error during Excel download.' });
  }
});

module.exports = router;


