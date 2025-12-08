const db = require('../config/db');

class AttendanceLogicService {
  constructor() {
    this.ZERO_METRICS = { 
      delay_by_minutes: 0, 
      extra_time_minutes: 0, 
      total_working_hours_decimal: 0, 
      ot_hours_decimal: 0 
    };
    this.MIN_OT_MINUTES = parseInt(process.env.MIN_OT_MINUTES || '15', 10);
    this.LOCAL_TIME_OFFSET_MINUTES = parseInt(process.env.LOCAL_TIME_OFFSET_MINUTES || '330', 10);
  }

  toLocalTime(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return date;
    if (!Number.isFinite(this.LOCAL_TIME_OFFSET_MINUTES) || this.LOCAL_TIME_OFFSET_MINUTES === 0) {
      return date;
    }
    return new Date(date.getTime() + this.LOCAL_TIME_OFFSET_MINUTES * 60 * 1000);
  }

  parseTime(timeStr) {
    const raw = String(timeStr).trim().toUpperCase();
    const hasAM = raw.includes('AM');
    const hasPM = raw.includes('PM');
    const timeOnly = raw.replace('AM', '').replace('PM', '').trim();
    const parts = timeOnly.split(':');
    let hour = parseInt(parts[0], 10) || 0;
    let minute = parseInt((parts[1] || '0').replace(/\D/g, ''), 10) || 0;

    if (hasAM && hour === 12) hour = 0;
    if (hasPM && hour !== 12) hour = hour + 12;

    return { hour, minute };
  }

  async getAllShifts(employeeType) {
    try {
      const { rows } = await db.query(
        `SELECT start_time, end_time, name, grace_before, grace_after, 
                presence_time, presence_count, presence_window 
         FROM shift_settings WHERE employee_type=$1 ORDER BY start_time ASC`,
        [employeeType]
      );
      if (rows.length === 0) return [];
      
      return rows.map(row => {
        const start = this.parseTime(row.start_time);
        const end = this.parseTime(row.end_time);
        return {
          name: row.name,
          startHour: start.hour,
          startMinute: start.minute,
          endHour: end.hour,
          endMinute: end.minute,
          graceBefore: row.grace_before || 0,
          graceAfter: row.grace_after || 0,
          presenceTime: row.presence_time || 3,
          presenceCount: row.presence_count || 3,
          presenceWindow: row.presence_window || 5
        };
      });
    } catch (error) {
      console.error(`Error fetching shifts for employee type ${employeeType}:`, error);
      return [];
    }
  }

  detectShiftForTime(checkInTime, shifts) {
    if (!shifts?.length) return null;
    
    const checkInMinutes = checkInTime.getHours() * 60 + checkInTime.getMinutes();
    
    for (let i = 0; i < shifts.length; i++) {
      const shift = shifts[i];
      const shiftStartMinutes = shift.startHour * 60 + shift.startMinute;
      const shiftEndMinutes = shift.endHour * 60 + shift.endMinute;
      const isMidnightShift = shiftEndMinutes < shiftStartMinutes;
      const isInShift = isMidnightShift
        ? (checkInMinutes >= shiftStartMinutes || checkInMinutes <= shiftEndMinutes)
        : (checkInMinutes >= shiftStartMinutes && checkInMinutes <= shiftEndMinutes);
      
      if (isInShift) return { shiftIndex: i, shift };
    }
    
    return { shiftIndex: 0, shift: shifts[0] };
  }

  buildLocalTime(baseTime, hour, minute) {
    const d = new Date(baseTime);
    d.setHours(hour, minute, 0, 0);
    return d;
  }

  buildShiftEndTime(baseTime, shift) {
    const start = this.buildLocalTime(baseTime, shift.startHour, shift.startMinute);
    const end = this.buildLocalTime(baseTime, shift.endHour, shift.endMinute);
    if (end.getTime() <= start.getTime()) {
      end.setDate(end.getDate() + 1);
    }
    return end;
  }

  isWithinCheckInWindow(time, shift) {
    if (!shift) return false;
    const startAt = this.buildLocalTime(time, shift.startHour, shift.startMinute);
    const endAt = this.buildShiftEndTime(time, shift);
    const earliest = new Date(startAt.getTime() - (shift.graceBefore || 30) * 60 * 1000);
    return time.getTime() >= earliest.getTime() && time.getTime() <= endAt.getTime();
  }

  isWithinCheckOutWindow(time, shift) {
    if (!shift) return false;
    const endAt = this.buildShiftEndTime(time, shift);
    const startAt = new Date(endAt.getTime() - 30 * 60 * 1000);
    return time.getTime() >= startAt.getTime() && time.getTime() <= endAt.getTime();
  }

  findShiftByCheckInWindow(time, shifts) {
    if (!shifts?.length) return null;
    for (let i = 0; i < shifts.length; i++) {
      if (this.isWithinCheckInWindow(time, shifts[i])) {
        return { shiftIndex: i, shift: shifts[i] };
      }
    }
    return null;
  }

  findShiftForPunchWithGrace(time, shifts) {
    if (!shifts?.length) return null;
    for (let i = 0; i < shifts.length; i++) {
      const shift = shifts[i];
      const startAt = this.buildLocalTime(time, shift.startHour, shift.startMinute);
      const endAt = this.buildShiftEndTime(time, shift);
      const earliest = new Date(startAt.getTime() - (shift.graceBefore || 0) * 60 * 1000);
      const latest = new Date(endAt.getTime() + (shift.graceAfter || 0) * 60 * 1000);
      if (time.getTime() >= earliest.getTime() && time.getTime() <= latest.getTime()) {
        return { shiftIndex: i, shift };
      }
    }
    return this.detectShiftForTime(time, shifts);
  }

  getShiftEndWithGrace(time, shift) {
    const endAt = this.buildShiftEndTime(time, shift);
    return new Date(endAt.getTime() + (shift.graceAfter || 0) * 60 * 1000);
  }

  async calculateAttendanceMetrics(inTimeStr, outTimeStr, employeeType, isOTShift = false) {
    if (!inTimeStr || !outTimeStr || !employeeType) {
      return this.ZERO_METRICS;
    }

    const shifts = await this.getAllShifts(employeeType);
    if (shifts.length === 0) return this.ZERO_METRICS;

    const inTime = this.toLocalTime(new Date(inTimeStr));
    const outTime = this.toLocalTime(new Date(outTimeStr));

    if (isNaN(inTime.getTime()) || isNaN(outTime.getTime()) || outTime.getTime() <= inTime.getTime()) {
      return this.ZERO_METRICS;
    }

    const total_working_hours_decimal = Math.max(0, parseFloat(((outTime.getTime() - inTime.getTime()) / (1000 * 60 * 60)).toFixed(2)));
    const detectedShift = this.detectShiftForTime(inTime, shifts);
    const shift = detectedShift?.shift || shifts[0];

    const shiftStartTime = this.buildLocalTime(inTime, shift.startHour, shift.startMinute);
    const shiftEndTime = this.buildShiftEndTime(inTime, shift);

    let delay_by_minutes = 0;
    if (inTime.getTime() > shiftStartTime.getTime()) {
      delay_by_minutes = Math.round((inTime.getTime() - shiftStartTime.getTime()) / (1000 * 60));
    }

    let extra_time_minutes = 0;
    if (outTime.getTime() > shiftEndTime.getTime()) {
      extra_time_minutes = Math.round((outTime.getTime() - shiftEndTime.getTime()) / (1000 * 60));
    }

    let ot_hours_decimal = 0;
    const otStartThreshold = new Date(shiftEndTime.getTime() + (shift.graceAfter || 0) * 60 * 1000);
    if (outTime.getTime() > otStartThreshold.getTime()) {
      const otMinutesFromEnd = Math.round((outTime.getTime() - shiftEndTime.getTime()) / (1000 * 60));
      if (otMinutesFromEnd >= this.MIN_OT_MINUTES) {
        ot_hours_decimal = parseFloat((otMinutesFromEnd / 60).toFixed(2));
      }
    }

    return {
      delay_by_minutes: Math.max(0, delay_by_minutes),
      extra_time_minutes: Math.max(0, extra_time_minutes),
      total_working_hours_decimal,
      ot_hours_decimal
    };
  }
}

const attendanceLogicService = new AttendanceLogicService();

module.exports = {
  calculateAttendanceMetrics: (inTimeStr, outTimeStr, employeeType, isOTShift) =>
    attendanceLogicService.calculateAttendanceMetrics(inTimeStr, outTimeStr, employeeType, isOTShift),
  getAllShifts: (employeeType) =>
    attendanceLogicService.getAllShifts(employeeType),
  detectShiftForTime: (checkInTime, shifts) =>
    attendanceLogicService.detectShiftForTime(checkInTime, shifts),
  isWithinCheckInWindow: (time, shift) =>
    attendanceLogicService.isWithinCheckInWindow(time, shift),
  isWithinCheckOutWindow: (time, shift) =>
    attendanceLogicService.isWithinCheckOutWindow(time, shift),
  findShiftByCheckInWindow: (time, shifts) =>
    attendanceLogicService.findShiftByCheckInWindow(time, shifts),
  findShiftForPunchWithGrace: (time, shifts) =>
    attendanceLogicService.findShiftForPunchWithGrace(time, shifts),
  getShiftEndWithGrace: (time, shift) =>
    attendanceLogicService.getShiftEndWithGrace(time, shift),
  buildLocalTime: (baseTime, hour, minute) =>
    attendanceLogicService.buildLocalTime(baseTime, hour, minute),
  buildShiftEndTime: (baseTime, shift) =>
    attendanceLogicService.buildShiftEndTime(baseTime, shift),
  toLocalTime: (date) =>
    attendanceLogicService.toLocalTime(date)
};
