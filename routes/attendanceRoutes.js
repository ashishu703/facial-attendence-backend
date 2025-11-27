const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const exceljs = require('exceljs');
const db = require('../config/db');
const { getFaceEmbedding } = require('../services/faceRecognitionService');
const { 
  calculateAttendanceMetrics, 
  getAllShifts, 
  detectShiftForTime,
  isWithinCheckInWindow,
  isWithinCheckOutWindow,
  findShiftByCheckInWindow,
  findShiftForPunchWithGrace,
  buildLocalTime
} = require('../services/attendanceLogicService');
const { 
  recordPresenceDetection, 
  checkPresenceRequirement 
} = require('../services/presenceDetectionService');
const { triggerAttendanceNotifications } = require('../services/notificationService');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Helper function to count completed shifts for an employee on a given date
async function getCompletedCount(employeeId, date) {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) as count FROM attendance_records 
       WHERE employee_id = $1 AND attendance_date = $2 AND out_time IS NOT NULL`,
      [employeeId, date]
    );
    return parseInt(rows[0]?.count || 0, 10);
  } catch (error) {
    console.error('Error getting completed count:', error);
    return 0;
  }
}

// Helper function removed - no auto check-in to next shift
// Employee must manually check-in for each shift

// Auto-checkout function for overdue shifts (4 hours after shift end)
async function autoCheckoutOverdueShifts() {
  try {
    const { rows } = await db.query(
      `SELECT r.*, d.employee_type, d.employee_name
       FROM attendance_records r
       JOIN employee_details d ON r.employee_id = d.employee_id
       WHERE r.out_time IS NULL`
    );

    for (const record of rows) {
      const shifts = await getAllShifts(record.employee_type);
      if (shifts.length === 0) continue;

      const inTime = new Date(record.in_time);
      const detectedShift = detectShiftForTime(inTime, shifts);
      const shift = detectedShift?.shift || shifts[0];
      
      // Calculate shift end time
      const shiftEndTime = new Date(inTime);
      shiftEndTime.setHours(shift.endHour, shift.endMinute, 0, 0);
      if (shiftEndTime <= inTime) {
        shiftEndTime.setDate(shiftEndTime.getDate() + 1);
      }
      
      // Auto-checkout at shift end + 4 hours
      const autoCheckoutTime = new Date(shiftEndTime.getTime() + 4 * 60 * 60 * 1000);
      const now = new Date();
      
      // Check if current time >= shift end + 4 hours
      if (now >= autoCheckoutTime) {
        console.log(`[AUTO-CHECKOUT] Processing auto-checkout for ${record.employee_name} (ID: ${record.employee_id})`);
        console.log(`[AUTO-CHECKOUT] Shift end: ${shiftEndTime.toISOString()}, Auto-checkout time: ${autoCheckoutTime.toISOString()}`);
        
        const completedCount = await getCompletedCount(record.employee_id, record.attendance_date);
        const isOTShift = completedCount > 0;
        
        // Checkout at current time (shift end + 4 hours), not at shift end time
        const checkoutTime = autoCheckoutTime.toISOString();
        
        const metrics = await calculateAttendanceMetrics(
          record.in_time,
          checkoutTime,
          record.employee_type,
          isOTShift
        );

        await db.query(
          `UPDATE attendance_records
           SET out_time = $1::timestamp, location_out = $2, delay_by_minutes = $3,
               extra_time_minutes = $4, total_working_hours_decimal = $5
           WHERE attendance_id = $6`,
          [checkoutTime, 'Auto Checkout (4h grace)', metrics.delay_by_minutes, 
           metrics.extra_time_minutes, metrics.total_working_hours_decimal, record.attendance_id]
        );
        
        console.log(`[AUTO-CHECKOUT] ✅ Auto-checkout completed for ${record.employee_name} at ${checkoutTime}`);
      }
    }
  } catch (error) {
    console.error('[AUTO-CHECKOUT] Error:', error);
  }
}

// Run auto-checkout every hour
setInterval(autoCheckoutOverdueShifts, 60 * 60 * 1000);


const upload = multer({
  dest: process.env.UPLOAD_PATH,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) },
});

const FACE_MATCH_THRESHOLD = 0.45; // Stricter threshold for better security
let constraintAdjusted = false;
const ensureMultiPunchSupport = async () => {
  if (constraintAdjusted) return;
  try {
    await db.query('ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_employee_id_attendance_date_key');
    await db.query('CREATE INDEX IF NOT EXISTS idx_attendance_emp_date ON attendance_records(employee_id, attendance_date, in_time)');
  } catch (_e) {}
  constraintAdjusted = true;
};

router.post('/mark', protect, upload.single('image'), async (req, res) => {
  const startTime = Date.now();
  const requestId = `MARK-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  console.log(`\n[${requestId}] ========== MARK ATTENDANCE REQUEST ==========`);
  
  const { latitude, longitude, timestamp, date } = req.body;
  const location = `(${latitude}, ${longitude})`;

  if (!req.file) {
    console.log(`[${requestId}] ❌ No image file provided`);
    return res.status(400).json({ message: 'Image file is required.' });
  }

  if (!timestamp || !date) {
    console.log(`[${requestId}] ❌ Missing timestamp or date`);
    return res.status(400).json({ message: 'Timestamp and date are required in the payload.' });
  }

  const timestampStr = String(timestamp).trim();
  const timestampDate = new Date(timestampStr);
  if (isNaN(timestampDate.getTime())) {
    console.log(`[${requestId}] ❌ Invalid timestamp format`);
    return res.status(400).json({ message: 'Invalid timestamp format.' });
  }

  try {
    await ensureMultiPunchSupport();
    const imagePath = path.resolve(req.file.path);
    const imageBuffer = fs.readFileSync(imagePath);
    
    console.log(`[${requestId}] Step 1: Extracting face embedding...`);
    const embedding = await getFaceEmbedding(imageBuffer);
    fs.unlinkSync(imagePath);

    if (!embedding) {
      console.log(`[${requestId}] ❌ No face detected in image`);
      return res.status(400).json({ message: 'No face detected.' });
    }

    console.log(`[${requestId}] Step 2: Matching face with database...`);
    const embeddingString = `[${embedding.join(',')}]`;
    const { rows } = await db.query(
      `SELECT employee_id, employee_name, employee_type, face_embedding <-> $1::vector AS distance
       FROM employee_details ORDER BY distance ASC LIMIT 1`,
      [embeddingString]
    );

    if (rows.length === 0) {
      console.log(`[${requestId}] ❌ No employees found in database`);
      return res.status(404).json({ message: 'No employees registered.' });
    }

    const bestMatch = rows[0];
    const processingTime = Date.now() - startTime;
    
    console.log(`[${requestId}] Best match: ${bestMatch.employee_name}`);
    console.log(`[${requestId}] Distance: ${bestMatch.distance.toFixed(4)} (threshold: ${FACE_MATCH_THRESHOLD})`);
    
    if (bestMatch.distance > FACE_MATCH_THRESHOLD) {
      console.log(`[${requestId}] ❌ FACE NOT MATCHED - Distance too high (${processingTime}ms)`);
      return res.status(401).json({ 
        message: 'Authentication failed. Face not recognized.',
        debug_distance: bestMatch.distance,
        threshold: FACE_MATCH_THRESHOLD
      });
    }
    
    console.log(`[${requestId}] ✅ FACE MATCHED: ${bestMatch.employee_name} (${processingTime}ms)`);

    const { employee_id, employee_name, employee_type } = bestMatch;
    const checkInTime = new Date(timestampStr);
    const shifts = await getAllShifts(employee_type);
    
    if (shifts.length === 0) {
      return res.status(400).json({ message: 'No shift settings found for your employee type.' });
    }

    const detectedShift = findShiftForPunchWithGrace(checkInTime, shifts) || detectShiftForTime(checkInTime, shifts);
    const shift = detectedShift?.shift || shifts[0];

    const incompleteRecord = await db.query(
      `SELECT * FROM attendance_records 
       WHERE employee_id = $1 AND attendance_date = $2 AND out_time IS NULL
       ORDER BY in_time DESC LIMIT 1`,
      [employee_id, date]
    );

    if (incompleteRecord.rows.length > 0) {
      const record = incompleteRecord.rows[0];
      const recordCheckInTime = new Date(record.in_time);
      const checkOutTime = new Date(timestampStr);
      
      if (checkOutTime.getTime() <= recordCheckInTime.getTime()) {
        return res.status(400).json({ 
          message: 'Invalid checkout time. Check-out time must be after check-in time.',
          check_in: record.in_time,
          check_out: timestampStr
        });
      }
      
      // Normal checkout - no auto check-in to next shift
      // Employee must manually check-in to next shift
      const completedCount = await getCompletedCount(employee_id, date);
      const isOTShift = completedCount > 0;
      const metrics = await calculateAttendanceMetrics(record.in_time, timestampStr, employee_type, isOTShift);

      // Get shift name for this record (reuse recordCheckInTime from above)
      const recordDetectedShift = detectShiftForTime(recordCheckInTime, shifts);
      const recordShift = recordDetectedShift?.shift || shifts[0];
      const shiftName = recordShift.name || 'Unknown Shift';

      const updatedRecord = await db.query(
        `UPDATE attendance_records
         SET out_time = $1::timestamp, location_out = $2, delay_by_minutes = $3,
             extra_time_minutes = $4, total_working_hours_decimal = $5
         WHERE attendance_id = $6
         RETURNING total_working_hours_decimal`,
        [timestampStr, location, metrics.delay_by_minutes, metrics.extra_time_minutes, 
         metrics.total_working_hours_decimal, record.attendance_id]
      );

      // Get employee details for notification
      const empDetails = await db.query(
        `SELECT e.employee_code, e.email, e.phone_number, o.organization_name
         FROM employee_details e
         LEFT JOIN organizations o ON e.organization_id = o.organization_id
         WHERE e.employee_id = $1`,
        [employee_id]
      );

      // Trigger notifications (async, don't block response)
      if (empDetails.rows.length > 0) {
        const empData = empDetails.rows[0];
        console.log(`[ATTENDANCE] 📧 Preparing to send notifications for ${employee_name} (checked_out)`);
        console.log(`[ATTENDANCE] Employee email: ${empData.email || 'NOT SET'}`);
        
        // Format date for notification
        const notificationDate = new Date(date).toLocaleDateString('en-IN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
        
        triggerAttendanceNotifications('checked_out', {
          employee_id,
          employee_name,
          employee_code: empData.employee_code || '',
          organization_name: empData.organization_name || '',
          date: notificationDate,
          time: new Date(timestampStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
          in_time: new Date(record.in_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
          out_time: new Date(timestampStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
          total_hours: updatedRecord.rows[0].total_working_hours_decimal,
          status: 'checked_out',
        }).catch(err => {
          console.error('[ATTENDANCE] ❌ Notification trigger error:', err);
        });
      } else {
        console.log(`[ATTENDANCE] ⚠️ No employee details found for ID: ${employee_id}`);
      }

      res.status(200).json({
        status: 'checked_out',
        employee_name,
        out_time: timestampStr,
        total_hours: updatedRecord.rows[0].total_working_hours_decimal,
        is_ot: isOTShift,
        ot_hours: metrics.ot_hours_decimal || 0,
        shift_name: shiftName,
        message: `Thank you ${employee_name}! You have checked out successfully from ${shiftName}.${isOTShift ? ' (OT Shift)' : ''}${metrics.ot_hours_decimal > 0 ? ` OT: ${metrics.ot_hours_decimal} hours` : ''}`
      });
    } else {
      // Check-in allowed from (start - graceBefore) through end + graceAfter of the matched shift
      const match = findShiftForPunchWithGrace(checkInTime, shifts);
      const matchShift = match?.shift || null;
      if (!matchShift) {
        await recordPresenceDetection(employee_id, timestampStr, date);
        return res.status(400).json({ message: 'Check-in not within any shift window.' });
      }

      await recordPresenceDetection(employee_id, timestampStr, date);
      
      const enforcePresence = (process.env.ENFORCE_PRESENCE || 'false').toLowerCase() === 'true';
      if (enforcePresence) {
        const presenceValid = await checkPresenceRequirement(
          employee_id, 
          date, 
          matchShift.presenceTime, 
          matchShift.presenceCount, 
          matchShift.presenceWindow
        );
        if (!presenceValid) {
          return res.status(400).json({ 
            message: `Presence requirement not met. Please ensure continuous presence for ${matchShift.presenceTime} seconds or ${matchShift.presenceCount} detections within ${matchShift.presenceWindow} seconds.` 
          });
        }
      }

      // Calculate delay at check-in so that late arrivals are visible on dashboards
      let delayAtCheckInMinutes = 0;
      try {
        const shiftStart = buildLocalTime(checkInTime, matchShift.startHour, matchShift.startMinute);
        if (checkInTime.getTime() > shiftStart.getTime()) {
          delayAtCheckInMinutes = Math.round(
            (checkInTime.getTime() - shiftStart.getTime()) / (1000 * 60)
          );
        }
      } catch (err) {
        console.error('Error calculating delay at check-in:', err);
      }

      await db.query(
        'INSERT INTO attendance_records (employee_id, attendance_date, in_time, location_in, delay_by_minutes) VALUES ($1, $2, $3::timestamp, $4, $5)',
        [employee_id, date, timestampStr, location, delayAtCheckInMinutes]
      );

      // Get employee details for notification
      const empDetails = await db.query(
        `SELECT e.employee_code, e.email, e.phone_number, o.organization_name
         FROM employee_details e
         LEFT JOIN organizations o ON e.organization_id = o.organization_id
         WHERE e.employee_id = $1`,
        [employee_id]
      );

      // Trigger notifications (async, don't block response)
      if (empDetails.rows.length > 0) {
        const empData = empDetails.rows[0];
        console.log(`[ATTENDANCE] 📧 Preparing to send notifications for ${employee_name} (checked_in)`);
        console.log(`[ATTENDANCE] Employee email: ${empData.email || 'NOT SET'}`);
        
        // Format date for notification
        const notificationDate = new Date(date).toLocaleDateString('en-IN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
        
        triggerAttendanceNotifications('checked_in', {
          employee_id,
          employee_name,
          employee_code: empData.employee_code || '',
          organization_name: empData.organization_name || '',
          date: notificationDate,
          time: new Date(timestampStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
          in_time: new Date(timestampStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
          status: 'checked_in',
        }).catch(err => {
          console.error('[ATTENDANCE] ❌ Notification trigger error:', err);
        });
      } else {
        console.log(`[ATTENDANCE] ⚠️ No employee details found for ID: ${employee_id}`);
      }

      // Get shift name for check-in
      const checkInCompletedCount = await getCompletedCount(employee_id, date);
      const isCheckInOT = checkInCompletedCount > 0;
      const checkInShiftName = matchShift.name || 'Unknown Shift';

      res.status(201).json({
        status: 'checked_in',
        employee_name,
        in_time: timestampStr,
        is_ot: isCheckInOT,
        shift_name: checkInShiftName,
        message: `Hi ${employee_name}! You have checked in successfully to ${checkInShiftName}.${isCheckInOT ? ' (OT Shift)' : ''}`
      });
    }
  } catch (error) {
    console.error('Attendance marking error:', error);
    if (error && error.code === '23505') {
      // Return a friendly response if duplicate insert attempted
      return res.status(200).json({ status: 'already_marked', message: 'Attendance already recorded for today.' });
    }
    res.status(500).json({ message: 'Server error during attendance marking.' });
  }
});

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
      
      if (row.delay_by_minutes !== metrics.delay_by_minutes || 
          row.extra_time_minutes !== metrics.extra_time_minutes ||
          row.total_working_hours_decimal !== metrics.total_working_hours_decimal) {
        db.query(
          'UPDATE attendance_records SET delay_by_minutes = $1, extra_time_minutes = $2, total_working_hours_decimal = $3 WHERE attendance_id = $4',
          [metrics.delay_by_minutes, metrics.extra_time_minutes, metrics.total_working_hours_decimal, row.attendance_id]
        ).catch(err => console.error('Error updating attendance record:', err));
      }
    }
    
    // Get shift name
    let shiftName = 'Unknown Shift';
    if (row.in_time && row.employee_type) {
      const shifts = await getAllShifts(row.employee_type);
      if (shifts.length > 0) {
        const inTime = new Date(row.in_time);
        const detectedShift = detectShiftForTime(inTime, shifts);
        shiftName = detectedShift?.shift?.name || shifts[0].name || 'Unknown Shift';
      }
    }
    
    return {
      ...row,
      in_time: row.in_time ? new Date(row.in_time).toISOString() : null,
      out_time: row.out_time ? new Date(row.out_time).toISOString() : null,
      ...metrics,
      ot_hours_decimal: metrics.ot_hours_decimal || 0,
      is_ot: isOTShift,
      shift_name: shiftName
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

