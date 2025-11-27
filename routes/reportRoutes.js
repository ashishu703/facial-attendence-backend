const express = require('express');
const db = require('../config/db');
const { protect } = require('../middleware/authMiddleware');
const { getAllShifts, buildLocalTime, buildShiftEndTime, calculateAttendanceMetrics, detectShiftForTime } = require('../services/attendanceLogicService');

const router = express.Router();

// Get organization-wise statistics for today
router.get('/organization-stats', protect, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const { rows } = await db.query(
      `WITH org_stats AS (
        SELECT 
          o.organization_id,
          o.organization_name,
          COUNT(DISTINCT e.employee_id) as total_employees,
          COUNT(DISTINCT CASE WHEN ar.attendance_date = $1 THEN ar.employee_id END) as present_today,
          COUNT(DISTINCT CASE WHEN ar.attendance_date = $1 AND ar.delay_by_minutes > 0 THEN ar.employee_id END) as late_arrivals,
          COUNT(DISTINCT CASE WHEN ar.attendance_date = $1 AND ar.out_time IS NULL THEN ar.employee_id END) as not_checked_out,
          COUNT(DISTINCT CASE WHEN ar.attendance_date = $1 AND EXISTS (
            SELECT 1 FROM attendance_records ar2 
            WHERE ar2.employee_id = ar.employee_id 
            AND ar2.attendance_date = $1 
            AND ar2.out_time IS NOT NULL
          ) THEN ar.employee_id END) as early_departures
        FROM organizations o
        LEFT JOIN employee_details e ON e.organization_id = o.organization_id
        LEFT JOIN attendance_records ar ON ar.employee_id = e.employee_id
        GROUP BY o.organization_id, o.organization_name
      ),
      ot_stats AS (
        SELECT 
          e.organization_id,
          COUNT(DISTINCT e.employee_id) as ot_employees
        FROM employee_details e
        JOIN attendance_records ar ON ar.employee_id = e.employee_id
        WHERE ar.attendance_date = $1
        AND (
          SELECT COUNT(*) FROM attendance_records ar2 
          WHERE ar2.employee_id = e.employee_id 
          AND ar2.attendance_date = $1 
          AND ar2.out_time IS NOT NULL
        ) > 0
        GROUP BY e.organization_id
      )
      SELECT 
        os.organization_id,
        os.organization_name,
        os.total_employees,
        os.present_today,
        COALESCE(os.total_employees - os.present_today, 0) as on_leave_today,
        os.late_arrivals,
        os.early_departures,
        COALESCE(ots.ot_employees, 0) as ot_employees,
        CASE 
          WHEN os.total_employees > 0 THEN (os.present_today::float / os.total_employees::float * 100)
          ELSE 0 
        END as attendance_percentage
      FROM org_stats os
      LEFT JOIN ot_stats ots ON ots.organization_id = os.organization_id
      ORDER BY os.organization_name`,
      [today]
    );
    
    res.json(rows);
  } catch (error) {
    console.error('Error fetching organization stats:', error);
    res.status(500).json({ message: 'Failed to fetch organization statistics' });
  }
});

// Alias endpoint for backward compatibility
router.get('/organizations/summary', protect, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const { rows } = await db.query(
      `WITH org_stats AS (
        SELECT 
          o.organization_id,
          o.organization_name,
          COUNT(DISTINCT e.employee_id) as total_employees,
          COUNT(DISTINCT CASE WHEN ar.attendance_date = $1 THEN ar.employee_id END) as present_today,
          COUNT(DISTINCT CASE WHEN ar.attendance_date = $1 AND ar.delay_by_minutes > 0 THEN ar.employee_id END) as late_arrivals,
          COUNT(DISTINCT CASE WHEN ar.attendance_date = $1 AND ar.out_time IS NULL THEN ar.employee_id END) as not_checked_out,
          COUNT(DISTINCT CASE WHEN ar.attendance_date = $1 AND EXISTS (
            SELECT 1 FROM attendance_records ar2 
            WHERE ar2.employee_id = ar.employee_id 
            AND ar2.attendance_date = $1 
            AND ar2.out_time IS NOT NULL
          ) THEN ar.employee_id END) as early_departures
        FROM organizations o
        LEFT JOIN employee_details e ON e.organization_id = o.organization_id
        LEFT JOIN attendance_records ar ON ar.employee_id = e.employee_id
        GROUP BY o.organization_id, o.organization_name
      ),
      ot_stats AS (
        SELECT 
          e.organization_id,
          COUNT(DISTINCT e.employee_id) as ot_employees
        FROM employee_details e
        JOIN attendance_records ar ON ar.employee_id = e.employee_id
        WHERE ar.attendance_date = $1
        AND (
          SELECT COUNT(*) FROM attendance_records ar2 
          WHERE ar2.employee_id = e.employee_id 
          AND ar2.attendance_date = $1 
          AND ar2.out_time IS NOT NULL
        ) > 0
        GROUP BY e.organization_id
      )
      SELECT 
        os.organization_id,
        os.organization_name,
        os.total_employees,
        os.present_today,
        COALESCE(os.total_employees - os.present_today, 0) as on_leave_today,
        os.late_arrivals,
        os.early_departures,
        COALESCE(ots.ot_employees, 0) as ot_employees,
        CASE 
          WHEN os.total_employees > 0 THEN (os.present_today::float / os.total_employees::float * 100)
          ELSE 0 
        END as attendance_percentage
      FROM org_stats os
      LEFT JOIN ot_stats ots ON ots.organization_id = os.organization_id
      ORDER BY os.organization_name`,
      [today]
    );
    
    res.json(rows);
  } catch (error) {
    console.error('Error fetching organization summary:', error);
    res.status(500).json({ message: 'Failed to fetch organization summary' });
  }
});

// Get employee attendance for a specific date (default: today)
router.get('/employee-attendance', protect, async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    const { rows } = await db.query(
      `WITH attendance_data AS (
        SELECT 
          e.employee_id,
          e.employee_code,
          e.employee_name,
          e.employee_type,
          o.organization_name,
          ar.in_time,
          ar.out_time,
          ar.total_working_hours_decimal as total_hours,
          CASE 
            WHEN EXISTS (
              SELECT 1 FROM attendance_records ar2 
              WHERE ar2.employee_id = e.employee_id 
              AND ar2.attendance_date = $1 
              AND ar2.out_time IS NOT NULL
            ) THEN true
            ELSE false
          END as is_ot,
          CASE 
            WHEN ar.attendance_id IS NOT NULL THEN 'Present'
            ELSE 'Absent'
          END as status
        FROM employee_details e
        LEFT JOIN organizations o ON o.organization_id = e.organization_id
        LEFT JOIN attendance_records ar ON ar.employee_id = e.employee_id AND ar.attendance_date = $1
      )
      SELECT * FROM attendance_data
      ORDER BY organization_name, employee_name`,
      [targetDate]
    );
    
    res.json(rows);
  } catch (error) {
    console.error('Error fetching employee attendance:', error);
    res.status(500).json({ message: 'Failed to fetch employee attendance' });
  }
});

// Get attendance trend for last N days
router.get('/attendance-trend', protect, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'startDate and endDate are required' });
    }
    
    const { rows } = await db.query(
      `WITH date_series AS (
        SELECT generate_series($1::date, $2::date, '1 day'::interval)::date as date
      ),
      daily_stats AS (
        SELECT 
          ds.date,
          COUNT(DISTINCT e.employee_id) as total_employees,
          COUNT(DISTINCT CASE WHEN ar.attendance_date = ds.date THEN ar.employee_id END) as present,
          COUNT(DISTINCT CASE WHEN ar.attendance_date = ds.date AND ar.delay_by_minutes > 0 THEN ar.employee_id END) as late,
          COUNT(DISTINCT CASE WHEN ar.attendance_date = ds.date AND EXISTS (
            SELECT 1 FROM attendance_records ar2 
            WHERE ar2.employee_id = ar.employee_id 
            AND ar2.attendance_date = ds.date 
            AND ar2.out_time IS NOT NULL
            AND ar2.attendance_id < ar.attendance_id
          ) THEN ar.employee_id END) as ot
        FROM date_series ds
        CROSS JOIN employee_details e
        LEFT JOIN attendance_records ar ON ar.employee_id = e.employee_id AND ar.attendance_date = ds.date
        GROUP BY ds.date
      )
      SELECT 
        date,
        COALESCE(present, 0) as present,
        COALESCE(total_employees - present, 0) as absent,
        COALESCE(ot, 0) as ot,
        COALESCE(late, 0) as late
      FROM daily_stats
      ORDER BY date ASC`,
      [startDate, endDate]
    );
    
    res.json(rows);
  } catch (error) {
    console.error('Error fetching attendance trend:', error);
    res.status(500).json({ message: 'Failed to fetch attendance trend' });
  }
});

// Get detailed attendance report with filters
router.get('/detailed-report', protect, async (req, res) => {
  try {
    const { startDate, endDate, organizationId, employeeType, searchText } = req.query;
    
    let query = `
      SELECT 
        ar.attendance_id,
        e.employee_code,
        e.employee_name,
        e.employee_type,
        o.organization_name,
        ar.attendance_date,
        ar.in_time,
        ar.out_time,
        ar.delay_by_minutes,
        ar.extra_time_minutes,
        ar.total_working_hours_decimal,
        COALESCE(ar.ot_hours_decimal, 0) as ot_hours_decimal,
        ar.location_in,
        ar.location_out,
        ar.is_edited,
        ar.edit_remark,
        ar.edited_at,
        CASE 
          WHEN (
            SELECT COUNT(*) FROM attendance_records ar2 
            WHERE ar2.employee_id = e.employee_id 
            AND ar2.attendance_date = ar.attendance_date 
            AND ar2.out_time IS NOT NULL
            AND ar2.attendance_id < ar.attendance_id
          ) > 0 THEN true
          ELSE false
        END as is_ot,
        COALESCE((
          SELECT name FROM shift_settings 
          WHERE employee_type = e.employee_type::text 
          ORDER BY created_at DESC 
          LIMIT 1
        ), 'Unknown Shift') as shift_name
      FROM attendance_records ar
      JOIN employee_details e ON e.employee_id = ar.employee_id
      LEFT JOIN organizations o ON o.organization_id = e.organization_id
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (startDate && endDate) {
      query += ` AND ar.attendance_date BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }
    
    if (organizationId) {
      query += ` AND e.organization_id = $${paramIndex}`;
      params.push(organizationId);
      paramIndex++;
    }
    
    if (employeeType) {
      query += ` AND e.employee_type = $${paramIndex}`;
      params.push(employeeType);
      paramIndex++;
    }
    
    if (searchText) {
      query += ` AND (e.employee_name ILIKE $${paramIndex} OR e.employee_code ILIKE $${paramIndex})`;
      params.push(`%${searchText}%`);
      paramIndex++;
    }
    
    query += ` ORDER BY ar.attendance_date DESC, e.employee_name, ar.in_time ASC`;
    
    const { rows } = await db.query(query, params);
    
    // Recalculate metrics and add early checkout for each row
    const processedRows = await Promise.all(rows.map(async (row) => {
      let early_checkout_minutes = 0;
      const dbOTHours = parseFloat(row.ot_hours_decimal) || 0;
      
      let recalculatedMetrics = {
        delay_by_minutes: row.delay_by_minutes || 0,
        extra_time_minutes: row.extra_time_minutes || 0,
        total_working_hours_decimal: row.total_working_hours_decimal || 0,
        ot_hours_decimal: dbOTHours
      };
      
      if (row.out_time && row.in_time && row.employee_type) {
        try {
          const isOTShift = row.is_ot || false;
          const metrics = await calculateAttendanceMetrics(row.in_time, row.out_time, row.employee_type, isOTShift);
          
          // Calculate regular shift hours and early checkout
          const shifts = await getAllShifts(row.employee_type);
          let regularShiftHours = 0;
          
          if (shifts.length > 0) {
            const inTime = new Date(row.in_time);
            const outTime = new Date(row.out_time);
            const detectedShiftResult = detectShiftForTime(inTime, shifts);
            const shift = detectedShiftResult?.shift || shifts[0];
            const shiftStartTime = buildLocalTime(inTime, shift.startHour, shift.startMinute);
            const shiftEndTime = buildShiftEndTime(inTime, shift);
            
            // Regular shift hours calculation:
            // - If checkout >= shift end: regularShiftHours = shift end - shift start
            // - If checkout < shift end: regularShiftHours = checkout - shift start
            if (outTime.getTime() >= shiftEndTime.getTime()) {
              // Checkout is at or after shift end: regular hours = full shift duration
              regularShiftHours = Math.max(0, parseFloat(((shiftEndTime.getTime() - shiftStartTime.getTime()) / (1000 * 60 * 60)).toFixed(2)));
            } else {
              // Early checkout: regular hours = actual worked hours
              regularShiftHours = Math.max(0, parseFloat(((outTime.getTime() - shiftStartTime.getTime()) / (1000 * 60 * 60)).toFixed(2)));
              early_checkout_minutes = Math.round((shiftEndTime.getTime() - outTime.getTime()) / (1000 * 60));
            }
          }
          
          // Determine OT hours: use DB value if exists (manually set), otherwise use calculated
          const finalOTHours = dbOTHours > 0 ? dbOTHours : (metrics.ot_hours_decimal || 0);
          
          // Total hours calculation:
          // - If manual OT is set: Total = Actual Worked Hours (checkout - checkin) + Manual OT
          // - If auto-calculated OT exists: Total = Regular Shift Hours + Auto OT
          // - If no OT: Total = Actual Worked Hours (checkout - checkin)
          let finalTotalHours;
          if (dbOTHours > 0) {
            // Manual OT: Add to actual worked hours
            finalTotalHours = Math.max(0, parseFloat((metrics.total_working_hours_decimal + dbOTHours).toFixed(2)));
          } else if (finalOTHours > 0) {
            // Auto-calculated OT: Add to regular shift hours
            finalTotalHours = Math.max(0, parseFloat((regularShiftHours + finalOTHours).toFixed(2)));
          } else {
            // No OT: Use actual worked hours
            finalTotalHours = metrics.total_working_hours_decimal;
          }
          
          recalculatedMetrics = {
            delay_by_minutes: metrics.delay_by_minutes,
            extra_time_minutes: metrics.extra_time_minutes,
            total_working_hours_decimal: finalTotalHours,
            ot_hours_decimal: finalOTHours
          };
        } catch (err) {
          console.error('Error recalculating metrics:', err);
        }
      }
      
      return {
        ...row,
        delay_by_minutes: recalculatedMetrics.delay_by_minutes,
        extra_time_minutes: recalculatedMetrics.extra_time_minutes,
        total_working_hours_decimal: recalculatedMetrics.total_working_hours_decimal,
        ot_hours_decimal: recalculatedMetrics.ot_hours_decimal || 0,
        early_checkout_minutes: Math.max(0, early_checkout_minutes)
      };
    }));
    
    res.json(processedRows);
  } catch (error) {
    console.error('Error fetching detailed report:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      message: 'Failed to fetch detailed report',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;
