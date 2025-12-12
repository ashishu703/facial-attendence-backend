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
const { consolidateDate, consolidateEmployeeDate } = require('../services/dailyConsolidationService');
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

/**
 * Fetch consolidated attendance rows (one row per employee per day)
 * Uses daily consolidation service to ensure accurate metrics
 */
async function fetchAttendanceRows(startDate, endDate) {
  await ensureEditColumns();
  
  if (!startDate || !endDate) {
    return [];
  }

  // Generate date range
  const start = new Date(startDate);
  const end = new Date(endDate);
  const dates = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().split('T')[0]);
  }

  // Get all employees (to include absent ones too)
  const { rows: employees } = await db.query(
    `SELECT DISTINCT e.employee_id, 
            COALESCE(e.employee_code, e.employee_id::text) AS employee_code, 
            e.employee_name, 
            e.employee_type
     FROM employee_details e
     ORDER BY e.employee_name`
  );

  // Consolidate for each employee for each date
  const { consolidateEmployeeDate } = require('../services/dailyConsolidationService');
  const allRows = [];

  for (const employee of employees) {
    for (const date of dates) {
      const consolidated = await consolidateEmployeeDate(employee.employee_id, date);
      
      // Get location from first valid session
      let locationIn = null;
      let locationOut = null;
      if (consolidated.effective_in_time) {
        const { rows: locRows } = await db.query(
          `SELECT location_in, location_out 
           FROM attendance_records 
           WHERE employee_id = $1 AND attendance_date = $2 AND in_time IS NOT NULL
           ORDER BY in_time ASC LIMIT 1`,
          [employee.employee_id, date]
        );
        if (locRows.length > 0) {
          locationIn = locRows[0].location_in;
          locationOut = locRows[0].location_out;
        }
      }

      // Get shift name
      let shiftName = 'Unknown Shift';
      if (employee.employee_type && consolidated.effective_in_time) {
        const shifts = await getAllShifts(employee.employee_type);
        if (shifts.length > 0) {
          const inTime = new Date(consolidated.effective_in_time);
          const detectedShift = detectShiftForTime(inTime, shifts);
          shiftName = detectedShift?.shift?.name || shifts[0].name || 'Unknown Shift';
        }
      }

      allRows.push({
        employee_code: employee.employee_code || employee.employee_id,
        employee_name: employee.employee_name,
        employee_type: employee.employee_type,
        attendance_date: date,
        in_time: consolidated.effective_in_time,
        out_time: consolidated.effective_out_time,
        delay_by_minutes: consolidated.delay_by_minutes,
        extra_time_minutes: consolidated.extra_time_minutes,
        total_working_hours_decimal: consolidated.total_work_hours,
        ot_hours_decimal: consolidated.ot_hours_decimal,
        location_in: locationIn,
        location_out: locationOut,
        is_ot: consolidated.ot_hours_decimal > 0,
        status: consolidated.status,
        missing_punch: consolidated.missing_punch
      });
    }
  }

  // Sort by date (desc), then employee name
  allRows.sort((a, b) => {
    if (a.attendance_date !== b.attendance_date) {
      return b.attendance_date.localeCompare(a.attendance_date);
    }
    return (a.employee_name || '').localeCompare(b.employee_name || '');
  });

  return allRows;
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

/**
 * Consolidated Daily Report
 * Returns one row per employee per day with effective IN/OUT and status
 */
router.get('/consolidated-report', protect, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ 
        message: 'startDate and endDate are required (format: YYYY-MM-DD)' 
      });
    }

    // Generate date range
    const start = new Date(startDate);
    const end = new Date(endDate);
    const dates = [];
    
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().split('T')[0]);
    }

    // Consolidate for each date
    const allResults = [];
    for (const date of dates) {
      const consolidated = await consolidateDate(date);
      allResults.push(...consolidated);
    }

    // Join with employee details for complete report
    const employeeIds = [...new Set(allResults.map(r => r.employee_id))];
    const { rows: employees } = await db.query(
      `SELECT employee_id, employee_name, employee_code, employee_type, organization_id
       FROM employee_details
       WHERE employee_id = ANY($1::uuid[])`,
      [employeeIds]
    );

    const employeeMap = new Map(employees.map(e => [e.employee_id, e]));

    // Get organization names
    const orgIds = [...new Set(employees.map(e => e.organization_id).filter(Boolean))];
    const { rows: orgs } = orgIds.length > 0 ? await db.query(
      `SELECT organization_id, organization_name FROM organizations WHERE organization_id = ANY($1::int[])`,
      [orgIds]
    ) : { rows: [] };
    const orgMap = new Map(orgs.map(o => [o.organization_id, o.organization_name]));

    // Build final report
    const report = allResults.map(result => {
      const emp = employeeMap.get(result.employee_id) || {};
      return {
        employee_id: result.employee_id,
        employee_code: emp.employee_code || result.employee_id,
        employee_name: emp.employee_name || 'Unknown',
        employee_type: emp.employee_type || 'Unknown',
        organization_name: emp.organization_id ? (orgMap.get(emp.organization_id) || '') : '',
        attendance_date: result.attendance_date,
        effective_in_time: result.effective_in_time,
        effective_out_time: result.effective_out_time,
        total_work_hours: result.total_work_hours,
        delay_by_minutes: result.delay_by_minutes,
        extra_time_minutes: result.extra_time_minutes,
        ot_hours_decimal: result.ot_hours_decimal,
        status: result.status,
        missing_punch: result.missing_punch,
        valid_sessions_count: result.valid_sessions_count
      };
    });

    res.json(report);
  } catch (error) {
    console.error('Consolidated report error:', error);
    res.status(500).json({ message: 'Server error fetching consolidated report.' });
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

/**
 * Download Consolidated Report as Excel
 */
router.get('/download-consolidated-excel', protect, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ 
        message: 'startDate and endDate are required (format: YYYY-MM-DD)' 
      });
    }

    // Generate date range
    const start = new Date(startDate);
    const end = new Date(endDate);
    const dates = [];
    
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().split('T')[0]);
    }

    // Consolidate for each date
    const allResults = [];
    for (const date of dates) {
      const consolidated = await consolidateDate(date);
      allResults.push(...consolidated);
    }

    // Join with employee details
    const employeeIds = [...new Set(allResults.map(r => r.employee_id))];
    const { rows: employees } = await db.query(
      `SELECT employee_id, employee_name, employee_code, employee_type, organization_id
       FROM employee_details
       WHERE employee_id = ANY($1::uuid[])`,
      [employeeIds]
    );

    const employeeMap = new Map(employees.map(e => [e.employee_id, e]));

    const orgIds = [...new Set(employees.map(e => e.organization_id).filter(Boolean))];
    const { rows: orgs } = orgIds.length > 0 ? await db.query(
      `SELECT organization_id, organization_name FROM organizations WHERE organization_id = ANY($1::int[])`,
      [orgIds]
    ) : { rows: [] };
    const orgMap = new Map(orgs.map(o => [o.organization_id, o.organization_name]));

    // Build report data
    const reportData = allResults.map(result => {
      const emp = employeeMap.get(result.employee_id) || {};
      return {
        employee_code: emp.employee_code || result.employee_id,
        employee_name: emp.employee_name || 'Unknown',
        employee_type: emp.employee_type || 'Unknown',
        organization_name: emp.organization_id ? (orgMap.get(emp.organization_id) || '') : '',
        attendance_date: new Date(result.attendance_date),
        effective_in_time: result.effective_in_time ? new Date(result.effective_in_time) : null,
        effective_out_time: result.effective_out_time ? new Date(result.effective_out_time) : null,
        total_work_hours: result.total_work_hours,
        delay_by_minutes: result.delay_by_minutes,
        extra_time_minutes: result.extra_time_minutes,
        ot_hours_decimal: result.ot_hours_decimal,
        status: result.status,
        missing_punch: result.missing_punch ? 'Yes' : 'No',
        valid_sessions_count: result.valid_sessions_count
      };
    });

    // Create Excel workbook
    const workbook = new exceljs.Workbook();
    const worksheet = workbook.addWorksheet('Consolidated Attendance Report');

    worksheet.columns = [
      { header: 'Employee Code', key: 'employee_code', width: 16 },
      { header: 'Employee Name', key: 'employee_name', width: 20 },
      { header: 'Employee Type', key: 'employee_type', width: 15 },
      { header: 'Organization', key: 'organization_name', width: 20 },
      { header: 'Attendance Date', key: 'attendance_date', width: 15 },
      { header: 'Effective In Time', key: 'effective_in_time', width: 20 },
      { header: 'Effective Out Time', key: 'effective_out_time', width: 20 },
      { header: 'Total Hours', key: 'total_work_hours', width: 12 },
      { header: 'Delay (minutes)', key: 'delay_by_minutes', width: 15 },
      { header: 'Extra Time (minutes)', key: 'extra_time_minutes', width: 18 },
      { header: 'OT Hours', key: 'ot_hours_decimal', width: 12 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Missing Punch', key: 'missing_punch', width: 12 },
      { header: 'Valid Sessions', key: 'valid_sessions_count', width: 12 },
    ];

    worksheet.addRows(reportData);

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
      `attachment; filename="consolidated_attendance_report_${startDate}_to_${endDate}.xlsx"`
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Consolidated Excel download error:', error);
    res.status(500).json({ message: 'Server error during Excel download.' });
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


