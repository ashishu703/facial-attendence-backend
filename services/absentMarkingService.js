const db = require('../config/db');
const { getAllShifts } = require('./attendanceLogicService');

class AbsentMarkingService {
  async markAbsentForShift(employeeType, shift, date) {
    try {
      const shiftEndTime = new Date(date);
      shiftEndTime.setUTCHours(shift.endHour, shift.endMinute, 0, 0);
      
      if (shift.endHour * 60 + shift.endMinute < shift.startHour * 60 + shift.startMinute) {
        shiftEndTime.setUTCDate(shiftEndTime.getUTCDate() + 1);
      }

      const now = new Date();
      if (now.getTime() < shiftEndTime.getTime()) {
        return;
      }

      // Ensure is_active column exists
      await db.query(`ALTER TABLE employee_details ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;`);
      
      const { rows: employees } = await db.query(
        'SELECT employee_id FROM employee_details WHERE employee_type = $1 AND COALESCE(is_active, true) = true',
        [employeeType]
      );

      for (const employee of employees) {
        const { rows: attendanceRecords } = await db.query(
          `SELECT * FROM attendance_records 
           WHERE employee_id = $1 AND attendance_date = $2`,
          [employee.employee_id, date]
        );

        if (attendanceRecords.length === 0) {
          await db.query(
            `INSERT INTO attendance_records 
             (employee_id, attendance_date, in_time, out_time) 
             VALUES ($1, $2, NULL, NULL)`,
            [employee.employee_id, date]
          );
        } else {
          const hasValidCheckIn = attendanceRecords.some(record => record.in_time !== null);
          const hasValidCheckOut = attendanceRecords.some(record => record.out_time !== null);
          
          if (!hasValidCheckIn) {
            const existingRecord = attendanceRecords.find(record => record.in_time === null && record.out_time === null);
            if (!existingRecord) {
              await db.query(
                `INSERT INTO attendance_records 
                 (employee_id, attendance_date, in_time, out_time) 
                 VALUES ($1, $2, NULL, NULL)`,
                [employee.employee_id, date]
              );
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error marking absent for shift ${shift.name} on ${date}:`, error);
    }
  }

  async processAbsentMarking() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const { rows: allShifts } = await db.query(
        'SELECT DISTINCT employee_type FROM shift_settings'
      );

      for (const { employee_type } of allShifts) {
        const shifts = await getAllShifts(employee_type);
        for (const shift of shifts) {
          await this.markAbsentForShift(employee_type, shift, today);
        }
      }
    } catch (error) {
      console.error('Error processing absent marking:', error);
    }
  }
}

const absentMarkingService = new AbsentMarkingService();

module.exports = {
  markAbsentForShift: (employeeType, shift, date) =>
    absentMarkingService.markAbsentForShift(employeeType, shift, date),
  processAbsentMarking: () =>
    absentMarkingService.processAbsentMarking()
};
