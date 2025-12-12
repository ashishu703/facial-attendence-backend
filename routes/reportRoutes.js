const express = require('express');
const db = require('../config/db');
const { protect } = require('../middleware/authMiddleware');
const { getAllShifts, buildLocalTime, buildShiftEndTime, calculateAttendanceMetrics, detectShiftForTime } = require('../services/attendanceLogicService');
const { consolidateEmployeeDate } = require('../services/dailyConsolidationService');

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
      -- Employees counted as OT only if they actually have OT hours recorded
      ot_stats AS (
        SELECT 
          e.organization_id,
          COUNT(DISTINCT e.employee_id) as ot_employees
        FROM employee_details e
        JOIN attendance_records ar ON ar.employee_id = e.employee_id
        WHERE ar.attendance_date = $1
          AND COALESCE(ar.ot_hours_decimal, 0) > 0
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
    
    const { rows: employees } = await db.query(
      `SELECT e.employee_id, e.employee_code, e.employee_name, 
              e.employee_type, e.organization_id, o.organization_name
       FROM employee_details e
       LEFT JOIN organizations o ON o.organization_id = e.organization_id
       ORDER BY o.organization_name, e.employee_name`
    );

    // Consolidate attendance for each employee
    const results = await Promise.all(employees.map(async (employee) => {
      const consolidated = await consolidateEmployeeDate(employee.employee_id, targetDate);
      
      return {
        employee_id: employee.employee_id,
        employee_code: employee.employee_code || employee.employee_id,
        employee_name: employee.employee_name,
        employee_type: employee.employee_type,
        organization_name: employee.organization_name || '',
        in_time: consolidated.effective_in_time,
        out_time: consolidated.effective_out_time,
        total_hours: consolidated.total_work_hours,
        is_ot: consolidated.ot_hours_decimal > 0,
        status: consolidated.status // Full Day / Half Day / Short / Absent
      };
    }));

    // Sort by organization and employee name
    results.sort((a, b) => {
      if (a.organization_name !== b.organization_name) {
        return (a.organization_name || '').localeCompare(b.organization_name || '');
      }
      return (a.employee_name || '').localeCompare(b.employee_name || '');
    });
    
    res.json(results);
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

router.get('/detailed-report', protect, async (req, res) => {
  try {
    const { startDate, endDate, organizationId, employeeType, searchText } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'startDate and endDate are required' });
    }

    // Generate date range
    const start = new Date(startDate);
    const end = new Date(endDate);
    const dates = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().split('T')[0]);
    }

    // Get all employees (including filters)
    let employeeQuery = `
      SELECT DISTINCT e.employee_id, e.employee_code, e.employee_name, 
             e.employee_type, e.organization_id, o.organization_name
      FROM employee_details e
      LEFT JOIN organizations o ON o.organization_id = e.organization_id
      WHERE 1=1
    `;
    const empParams = [];
    let empParamIndex = 1;

    if (organizationId) {
      employeeQuery += ` AND e.organization_id = $${empParamIndex}`;
      empParams.push(organizationId);
      empParamIndex++;
    }

    if (employeeType) {
      employeeQuery += ` AND e.employee_type = $${empParamIndex}`;
      empParams.push(employeeType);
      empParamIndex++;
    }

    if (searchText) {
      employeeQuery += ` AND (e.employee_name ILIKE $${empParamIndex} OR e.employee_code ILIKE $${empParamIndex})`;
      empParams.push(`%${searchText}%`);
      empParamIndex++;
    }

    employeeQuery += ` ORDER BY e.employee_name`;

    const { rows: employees } = await db.query(employeeQuery, empParams);

    // Consolidate attendance for each employee for each date
    const allResults = [];
    const { consolidateEmployeeDate } = require('../services/dailyConsolidationService');

    for (const employee of employees) {
      for (const date of dates) {
        const consolidated = await consolidateEmployeeDate(employee.employee_id, date);
        
        // Add employee details
        const result = {
          employee_id: employee.employee_id,
          employee_code: employee.employee_code || employee.employee_id,
          employee_name: employee.employee_name,
          employee_type: employee.employee_type,
          organization_name: employee.organization_name || '',
          attendance_date: date,
          in_time: consolidated.effective_in_time,
          out_time: consolidated.effective_out_time,
          delay_by_minutes: consolidated.delay_by_minutes,
          extra_time_minutes: consolidated.extra_time_minutes,
          total_working_hours_decimal: consolidated.total_work_hours,
          ot_hours_decimal: consolidated.ot_hours_decimal,
          status: consolidated.status, // Full Day / Half Day / Short / Absent
          missing_punch: consolidated.missing_punch,
          is_ot: consolidated.ot_hours_decimal > 0,
          shift_name: null, // Will be set below
          location_in: null,
          location_out: null,
          is_edited: false,
          edit_remark: null,
          edited_at: null
        };

        // Get shift name
        if (employee.employee_type) {
          const shifts = await getAllShifts(employee.employee_type);
          if (shifts.length > 0) {
            if (consolidated.effective_in_time) {
              const inTime = new Date(consolidated.effective_in_time);
              const detectedShift = detectShiftForTime(inTime, shifts);
              result.shift_name = detectedShift?.shift?.name || shifts[0].name || 'Unknown Shift';
            } else {
              result.shift_name = shifts[0].name || 'Unknown Shift';
            }
          }
        }

        // Get location from first valid session if exists
        if (consolidated.effective_in_time) {
          const { rows: locationRows } = await db.query(
            `SELECT location_in, location_out 
             FROM attendance_records 
             WHERE employee_id = $1 
               AND attendance_date = $2 
               AND in_time IS NOT NULL
             ORDER BY in_time ASC 
             LIMIT 1`,
            [employee.employee_id, date]
          );
          if (locationRows.length > 0) {
            result.location_in = locationRows[0].location_in;
            result.location_out = locationRows[0].location_out;
          }
        }

        // Only include if there's attendance data OR if filtering requires showing absent
        // For now, include all (present + absent)
        allResults.push(result);
      }
    }

    // Sort results
    allResults.sort((a, b) => {
      if (a.attendance_date !== b.attendance_date) {
        return b.attendance_date.localeCompare(a.attendance_date);
      }
      if (a.organization_name !== b.organization_name) {
        return (a.organization_name || '').localeCompare(b.organization_name || '');
      }
      return (a.employee_name || '').localeCompare(b.employee_name || '');
    });

    res.json(allResults);
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
