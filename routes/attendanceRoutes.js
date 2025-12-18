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
  findShiftForPunchWithGrace,
  buildLocalTime,
  toLocalTime
} = require('../services/attendanceLogicService');
const { 
  recordPresenceDetection, 
  checkPresenceRequirement 
} = require('../services/presenceDetectionService');
const { triggerAttendanceNotifications } = require('../services/notificationService');
const { handlePunch } = require('../services/punchHandlingService');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Utility: format a date in IST for email display
function formatISTDate(dateLike) {
  if (!dateLike) return '';
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

function formatISTTime(dateLike) {
  if (!dateLike) return '';
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  });
}

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


const upload = multer({
  dest: process.env.UPLOAD_PATH || 'uploads/',
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || `${5 * 1024 * 1024}`, 10), // default 5MB
  },
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

// NOTE: This route is intentionally left UNPROTECTED (no JWT required).
// Face + DB matching is used to identify the employee; frontend should be able
// to call this even before login / without token.
router.post('/mark', upload.single('image'), async (req, res) => {
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

    let imageBuffer;
    try {
      imageBuffer = fs.readFileSync(imagePath);
    } catch (readErr) {
      console.error(`[${requestId}] ❌ Error reading uploaded image:`, readErr);
      return res.status(500).json({ message: 'Error reading uploaded image.' });
    }
    
    console.log(`[${requestId}] Step 1: Extracting face embedding...`);
    let embedding;
    try {
      embedding = await getFaceEmbedding(imageBuffer);
    } catch (embedErr) {
      console.error(`[${requestId}] ❌ Error during face detection/embedding:`, embedErr);
      try {
        fs.unlinkSync(imagePath);
      } catch (_e) {}
      return res.status(400).json({
        message: embedErr.message || 'Error processing face image.',
      });
    }
    try {
      fs.unlinkSync(imagePath);
    } catch (_e) {}

    if (!embedding) {
      console.log(`[${requestId}] ❌ No face detected in image`);
      return res.status(400).json({ message: 'No face detected.' });
    }

    console.log(`[${requestId}] Step 2: Matching face with database...`);
    const embeddingString = `[${embedding.join(',')}]`;
    // Ensure is_active column exists
    await db.query(`ALTER TABLE employee_details ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;`);

    const { rows } = await db.query(
      `SELECT employee_id, employee_name, employee_type, COALESCE(is_active, true) as is_active, face_embedding <-> $1::vector AS distance
       FROM employee_details 
       WHERE COALESCE(is_active, true) = true
       ORDER BY distance ASC LIMIT 1`,
      [embeddingString]
    );

    if (rows.length === 0) {
      console.log(`[${requestId}] ❌ No active employees found in database`);
      return res.status(404).json({ message: 'No active employees registered.' });
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
    
    // Check if employee is active
    if (!bestMatch.is_active) {
      console.log(`[${requestId}] ❌ Employee is inactive: ${bestMatch.employee_name}`);
      return res.status(403).json({ 
        message: 'Employee is inactive. Attendance cannot be marked.',
      });
    }
    
    console.log(`[${requestId}] ✅ FACE MATCHED: ${bestMatch.employee_name} (${processingTime}ms)`);

    const { employee_id, employee_name, employee_type } = bestMatch;

    // Record presence detection (for forgot checkout analysis)
    await recordPresenceDetection(employee_id, timestampStr, date);

    // Check presence requirement if enabled
    const checkInTime = toLocalTime(new Date(timestampStr));
    const shifts = await getAllShifts(employee_type);
    
    if (shifts.length === 0) {
      return res.status(400).json({ message: 'No shift settings found for your employee type.' });
    }

    const match = findShiftForPunchWithGrace(checkInTime, shifts);
    const matchShift = match?.shift || null;
    
    if (matchShift) {
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
    }

    // Use new punch handling service
    try {
      const punchResult = await handlePunch(employee_id, employee_type, timestampStr, date, location);

      if (!punchResult.handled) {
        // Duplicate punch or other reason
        return res.status(200).json({
          status: 'ignored',
          message: punchResult.message || 'Punch ignored',
          reason: punchResult.reason
        });
      }

      // Get employee details for notification
      const empDetails = await db.query(
        `SELECT e.employee_code, e.email, e.phone_number, o.organization_name
         FROM employee_details e
         LEFT JOIN organizations o ON e.organization_id = o.organization_id
         WHERE e.employee_id = $1`,
        [employee_id]
      );

      const empData = empDetails.rows[0] || {};
      const notificationDate = formatISTDate(timestampStr);

      if (punchResult.type === 'OUT') {
        // Check-out notification
        const { rows: inTimeRows } = await db.query(
          `SELECT in_time FROM attendance_records WHERE attendance_id = $1`,
          [punchResult.attendance_id]
        );
        const inTime = inTimeRows[0]?.in_time;

        triggerAttendanceNotifications('checked_out', {
          employee_id,
          employee_name,
          employee_code: empData.employee_code || '',
          organization_name: empData.organization_name || '',
          date: notificationDate,
          time: formatISTTime(timestampStr),
          in_time: formatISTTime(inTime),
          out_time: formatISTTime(timestampStr),
          total_hours: punchResult.total_working_hours_decimal,
          status: 'checked_out',
        }).catch(err => {
          console.error('[ATTENDANCE] ❌ Notification trigger error:', err);
        });

        // Warn if session is invalid
        const attendanceConfig = require('../services/attendanceConfigService');
        const warningMsg = !punchResult.is_valid_session
          ? ` Note: Session too short (${punchResult.session_duration_minutes} min < ${attendanceConfig.MIN_SESSION_MIN} min) - not counted in working hours.`
          : '';

        res.status(200).json({
          status: 'checked_out',
          employee_name,
          out_time: timestampStr,
          total_hours: punchResult.total_working_hours_decimal,
          is_ot: punchResult.is_ot,
          ot_hours: punchResult.ot_hours_decimal || 0,
          shift_name: punchResult.shift_name,
          is_valid_session: punchResult.is_valid_session,
          session_duration_minutes: punchResult.session_duration_minutes,
          message: `Thank you ${employee_name}! You have checked out successfully from ${punchResult.shift_name}.${punchResult.is_ot ? ' (OT Shift)' : ''}${punchResult.ot_hours_decimal > 0 ? ` OT: ${punchResult.ot_hours_decimal} hours` : ''}${warningMsg}`
        });
      } else {
        // Check-in notification
        triggerAttendanceNotifications('checked_in', {
          employee_id,
          employee_name,
          employee_code: empData.employee_code || '',
          organization_name: empData.organization_name || '',
          date: notificationDate,
          time: formatISTTime(timestampStr),
          in_time: formatISTTime(timestampStr),
          status: 'checked_in',
        }).catch(err => {
          console.error('[ATTENDANCE] ❌ Notification trigger error:', err);
        });

        const checkInCompletedCount = await getCompletedCount(employee_id, date);
        const isCheckInOT = checkInCompletedCount > 0;

        res.status(201).json({
          status: 'checked_in',
          employee_name,
          in_time: timestampStr,
          is_ot: isCheckInOT,
          shift_name: punchResult.shift_name,
          delay_by_minutes: punchResult.delay_by_minutes,
          message: `Hi ${employee_name}! You have checked in successfully to ${punchResult.shift_name}.${isCheckInOT ? ' (OT Shift)' : ''}${punchResult.delay_by_minutes > 0 ? ` (Late by ${punchResult.delay_by_minutes} minutes)` : ''}`
        });
      }
    } catch (punchError) {
      console.error(`[${requestId}] Error in punch handling:`, punchError);
      
      // If it's a validation error from punch handler, return it
      if (punchError.message && (
        punchError.message.includes('shift') ||
        punchError.message.includes('Check-out') ||
        punchError.message.includes('Check-in')
      )) {
        return res.status(400).json({ message: punchError.message });
      }
      
      throw punchError; // Re-throw to be caught by outer catch
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
  // Ensure is_active column exists
  await db.query(`ALTER TABLE employee_details ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;`);
  
  let query = `SELECT COALESCE(d.employee_code, d.employee_id::text) AS employee_code,
    d.employee_name, d.employee_type, r.attendance_date, r.in_time::text AS in_time,
    CASE WHEN r.out_time IS NOT NULL THEN r.out_time::text ELSE NULL END AS out_time,
    r.delay_by_minutes, r.extra_time_minutes, r.total_working_hours_decimal,
    r.location_in, r.location_out, r.attendance_id, r.employee_id
    FROM attendance_records r JOIN employee_details d ON r.employee_id = d.employee_id
    WHERE COALESCE(d.is_active, true) = true`;
  const params = [];
  if (startDate && endDate) {
    params.push(startDate, endDate);
    query += ' AND r.attendance_date BETWEEN $1 AND $2';
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

