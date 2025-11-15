const express = require('express');
const exceljs = require('exceljs');
const db = require('../config/db');
const { calculateAttendanceMetrics } = require('../services/attendanceLogicService');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

async function fetchAttendanceRows(startDate, endDate) {
  let query = `SELECT COALESCE(d.employee_code, d.employee_id::text) AS employee_code,
    d.employee_name, d.employee_type, r.attendance_date, r.in_time::text AS in_time,
    CASE WHEN r.out_time IS NOT NULL THEN r.out_time::text ELSE NULL END AS out_time,
    r.delay_by_minutes, r.extra_time_minutes, r.total_working_hours_decimal,
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
    
    let metrics = {
      delay_by_minutes: row.delay_by_minutes || 0,
      extra_time_minutes: row.extra_time_minutes || 0,
      total_working_hours_decimal: row.total_working_hours_decimal || 0
    };
    
    if (row.out_time && row.in_time && row.employee_type) {
      const recalculated = await calculateAttendanceMetrics(row.in_time, row.out_time, row.employee_type, isOTShift);
      metrics = recalculated;
    }
    
    return {
      ...row,
      in_time: row.in_time ? new Date(row.in_time).toISOString() : null,
      out_time: row.out_time ? new Date(row.out_time).toISOString() : null,
      ...metrics,
      ot_hours_decimal: isOTShift ? metrics.total_working_hours_decimal : 0,
      is_ot: isOTShift
    };
  }));
  
  return processedRows;
}

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


