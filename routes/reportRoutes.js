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
    
    // Ensure is_active column exists
    await db.query(`ALTER TABLE employee_details ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;`);
    
    // Get all active employees with their organizations
    const { rows: employees } = await db.query(
      `SELECT e.employee_id, e.employee_type, e.organization_id, o.organization_name
       FROM employee_details e
       LEFT JOIN organizations o ON o.organization_id = e.organization_id
       WHERE COALESCE(e.is_active, true) = true`
    );
    
    // Consolidate attendance for each employee
    const consolidatedData = await Promise.all(
      employees.map(async (emp) => {
        const consolidated = await consolidateEmployeeDate(emp.employee_id, today);
        return {
          organization_id: emp.organization_id,
          organization_name: emp.organization_name || '',
          employee_id: emp.employee_id,
          status: consolidated.status,
          delay_by_minutes: consolidated.delay_by_minutes,
          ot_hours_decimal: consolidated.ot_hours_decimal,
          effective_in_time: consolidated.effective_in_time
        };
      })
    );
    
    // Group by organization and calculate stats
    const orgMap = new Map();
    
    consolidatedData.forEach((data) => {
      const orgId = data.organization_id;
      if (!orgMap.has(orgId)) {
        orgMap.set(orgId, {
          organization_id: orgId,
          organization_name: data.organization_name,
          total_employees: 0,
          present_today: 0,
          late_arrivals: 0,
          not_checked_out: 0,
          early_departures: 0,
          ot_employees: 0
        });
      }
      
      const org = orgMap.get(orgId);
      org.total_employees++;
      
      // Present: Has check-in (status is not "Absent" or has effective_in_time)
      if (data.effective_in_time || (data.status !== 'Absent' && data.status !== null)) {
        org.present_today++;
      }
      
      // Late arrivals: Checked in after shift start time (delay > 0)
      if (data.delay_by_minutes > 0) {
        org.late_arrivals++;
      }
      
      // Not checked out: Has check-in but no checkout
      if (data.effective_in_time && !data.effective_out_time) {
        org.not_checked_out++;
      }
      
      // OT employees: Has OT hours
      if (data.ot_hours_decimal > 0) {
        org.ot_employees++;
      }
    });
    
    // Convert to array and calculate percentages
    const results = Array.from(orgMap.values()).map(org => ({
      ...org,
      on_leave_today: Math.max(0, org.total_employees - org.present_today),
      attendance_percentage: org.total_employees > 0 
        ? parseFloat((org.present_today / org.total_employees * 100).toFixed(2))
        : 0
    }));
    
    res.json(results);
  } catch (error) {
    console.error('Error fetching organization stats:', error);
    res.status(500).json({ message: 'Failed to fetch organization statistics' });
  }
});

// Alias endpoint for backward compatibility
router.get('/organizations/summary', protect, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Use the same logic as organization-stats
    // Ensure is_active column exists
    await db.query(`ALTER TABLE employee_details ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;`);
    
    // Get all active employees with their organizations
    const { rows: employees } = await db.query(
      `SELECT e.employee_id, e.employee_type, e.organization_id, o.organization_name
       FROM employee_details e
       LEFT JOIN organizations o ON o.organization_id = e.organization_id
       WHERE COALESCE(e.is_active, true) = true`
    );
    
    // Consolidate attendance for each employee
    const consolidatedData = await Promise.all(
      employees.map(async (emp) => {
        const consolidated = await consolidateEmployeeDate(emp.employee_id, today);
        return {
          organization_id: emp.organization_id,
          organization_name: emp.organization_name || '',
          employee_id: emp.employee_id,
          status: consolidated.status,
          delay_by_minutes: consolidated.delay_by_minutes,
          ot_hours_decimal: consolidated.ot_hours_decimal,
          effective_in_time: consolidated.effective_in_time
        };
      })
    );
    
    // Group by organization and calculate stats
    const orgMap = new Map();
    
    consolidatedData.forEach((data) => {
      const orgId = data.organization_id;
      if (!orgMap.has(orgId)) {
        orgMap.set(orgId, {
          organization_id: orgId,
          organization_name: data.organization_name,
          total_employees: 0,
          present_today: 0,
          late_arrivals: 0,
          not_checked_out: 0,
          early_departures: 0,
          ot_employees: 0
        });
      }
      
      const org = orgMap.get(orgId);
      org.total_employees++;
      
      // Present: Has check-in (status is not "Absent" or has effective_in_time)
      if (data.effective_in_time || (data.status !== 'Absent' && data.status !== null)) {
        org.present_today++;
      }
      
      // Late arrivals: Checked in after shift start time (delay > 0)
      if (data.delay_by_minutes > 0) {
        org.late_arrivals++;
      }
      
      // Not checked out: Has check-in but no checkout
      if (data.effective_in_time && !data.effective_out_time) {
        org.not_checked_out++;
      }
      
      // OT employees: Has OT hours
      if (data.ot_hours_decimal > 0) {
        org.ot_employees++;
      }
    });
    
    // Convert to array and calculate percentages
    const results = Array.from(orgMap.values()).map(org => ({
      ...org,
      on_leave_today: Math.max(0, org.total_employees - org.present_today),
      attendance_percentage: org.total_employees > 0 
        ? parseFloat((org.present_today / org.total_employees * 100).toFixed(2))
        : 0
    }));
    
    res.json(results);
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
    
    // Ensure is_active column exists
    await db.query(`ALTER TABLE employee_details ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;`);
    
    const { rows: employees } = await db.query(
      `SELECT e.employee_id, e.employee_code, e.employee_name, 
              e.employee_type, e.organization_id, o.organization_name
       FROM employee_details e
       LEFT JOIN organizations o ON o.organization_id = e.organization_id
       WHERE COALESCE(e.is_active, true) = true
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
        WHERE COALESCE(e.is_active, true) = true
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

    // Ensure is_active column exists
    await db.query(`ALTER TABLE employee_details ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;`);
    
    // Get all employees (including filters)
    let employeeQuery = `
      SELECT DISTINCT e.employee_id, e.employee_code, e.employee_name, 
             e.employee_type, e.organization_id, o.organization_name
      FROM employee_details e
      LEFT JOIN organizations o ON o.organization_id = e.organization_id
      WHERE COALESCE(e.is_active, true) = true
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
        // If employee has check-in but no checkout, mark as Absent in report
        let reportStatus = consolidated.status;
        if (consolidated.effective_in_time && !consolidated.effective_out_time) {
          reportStatus = 'Absent'; // Mark as Absent if check-in but no checkout
        }
        
        const result = {
          employee_id: employee.employee_id,
          employee_code: employee.employee_code || employee.employee_id,
          employee_name: employee.employee_name,
          employee_type: employee.employee_type,
          organization_name: employee.organization_name || '',
          attendance_date: date,
          in_time: consolidated.effective_in_time,
          out_time: consolidated.effective_out_time, // Will be null if no checkout (shows as N/A in frontend)
          delay_by_minutes: consolidated.delay_by_minutes,
          extra_time_minutes: consolidated.extra_time_minutes,
          total_working_hours_decimal: consolidated.total_work_hours,
          ot_hours_decimal: consolidated.ot_hours_decimal,
          status: reportStatus, // Absent if check-in but no checkout
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
