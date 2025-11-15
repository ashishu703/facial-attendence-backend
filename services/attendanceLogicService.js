const db = require('../config/db');
const ZERO_METRICS = { delay_by_minutes: 0, extra_time_minutes: 0, total_working_hours_decimal: 0, ot_hours_decimal: 0 };
const MIN_OT_MINUTES = parseInt(process.env.MIN_OT_MINUTES || '15', 10);

const parseTime = (timeStr) => {
  const raw = String(timeStr).trim();
  const upper = raw.toUpperCase();
  const hasAM = upper.includes('AM');
  const hasPM = upper.includes('PM');

  const timeOnly = upper.replace('AM', '').replace('PM', '').trim();
  const parts = timeOnly.split(':');
  let hour = parseInt(parts[0], 10) || 0;
  let minute = parseInt((parts[1] || '0').replace(/\D/g, ''), 10) || 0;

  if (hasAM) {
    if (hour === 12) hour = 0;
  } else if (hasPM) {
    if (hour !== 12) hour = hour + 12;
  }

  return { hour, minute };
};

async function getAllShifts(employeeType) {
  try {
    const { rows } = await db.query(
      `SELECT start_time, end_time, name, grace_before, grace_after, 
              presence_time, presence_count, presence_window 
       FROM shift_settings WHERE employee_type=$1 ORDER BY start_time ASC`,
      [employeeType]
    );
    if (rows.length === 0) return [];
    
    return rows.map(row => {
      const start = parseTime(row.start_time);
      const end = parseTime(row.end_time);
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


function detectShiftForTime(checkInTime, shifts) {
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

function buildLocalTime(baseTime, hour, minute) {
  const d = new Date(baseTime);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function buildShiftEndTime(baseTime, shift) {
  const start = buildLocalTime(baseTime, shift.startHour, shift.startMinute);
  const end = buildLocalTime(baseTime, shift.endHour, shift.endMinute);
  if (end.getTime() <= start.getTime()) {
    end.setDate(end.getDate() + 1); // handle overnight shifts
  }
  return end;
}

function isWithinCheckInWindow(time, shift) {
  if (!shift) return false;
  const startAt = buildLocalTime(time, shift.startHour, shift.startMinute);
  const endAt = buildShiftEndTime(time, shift);
  // Grace period BEFORE shift start (graceBefore)
  // Check-in allowed from (start - graceBefore) up to shift end
  const earliest = new Date(startAt.getTime() - (shift.graceBefore || 30) * 60 * 1000);
  return time.getTime() >= earliest.getTime() && time.getTime() <= endAt.getTime();
}

// Check-out allowed window: [end - 30m, end]
function isWithinCheckOutWindow(time, shift) {
  if (!shift) return false;
  const endAt = buildShiftEndTime(time, shift);
  const startAt = new Date(endAt.getTime() - 30 * 60 * 1000);
  return time.getTime() >= startAt.getTime() && time.getTime() <= endAt.getTime();
}

function findShiftByCheckInWindow(time, shifts) {
  if (!shifts?.length) return null;
  for (let i = 0; i < shifts.length; i++) {
    if (isWithinCheckInWindow(time, shifts[i])) {
      return { shiftIndex: i, shift: shifts[i] };
    }
  }
  return null;
}

// Grace-aware shift detection for any punch (check-in or check-out)
function findShiftForPunchWithGrace(time, shifts) {
  if (!shifts?.length) return null;
  for (let i = 0; i < shifts.length; i++) {
    const shift = shifts[i];
    const startAt = buildLocalTime(time, shift.startHour, shift.startMinute);
    const endAt = buildShiftEndTime(time, shift);
    const earliest = new Date(startAt.getTime() - (shift.graceBefore || 0) * 60 * 1000);
    const latest = new Date(endAt.getTime() + (shift.graceAfter || 0) * 60 * 1000);
    if (time.getTime() >= earliest.getTime() && time.getTime() <= latest.getTime()) {
      return { shiftIndex: i, shift };
    }
  }
  return detectShiftForTime(time, shifts);
}

function getShiftEndWithGrace(time, shift) {
  const endAt = buildShiftEndTime(time, shift);
  return new Date(endAt.getTime() + (shift.graceAfter || 0) * 60 * 1000);
}

async function calculateAttendanceMetrics(inTimeStr, outTimeStr, employeeType, isOTShift = false) {
  if (!inTimeStr || !outTimeStr || !employeeType) {
    return ZERO_METRICS;
  }

  const shifts = await getAllShifts(employeeType);
  if (shifts.length === 0) return ZERO_METRICS;

  const inTime = new Date(inTimeStr);
  const outTime = new Date(outTimeStr);

  if (isNaN(inTime.getTime()) || isNaN(outTime.getTime()) || outTime.getTime() <= inTime.getTime()) {
    return ZERO_METRICS;
  }

  // Total hours = checkout time - checkin time
  const total_working_hours_decimal = Math.max(0, parseFloat(((outTime.getTime() - inTime.getTime()) / (1000 * 60 * 60)).toFixed(2)));
  const detectedShift = detectShiftForTime(inTime, shifts);
  const shift = detectedShift?.shift || shifts[0];

  // Build shift start and end times for the check-in date
  const shiftStartTime = buildLocalTime(inTime, shift.startHour, shift.startMinute);
  const shiftEndTime = buildShiftEndTime(inTime, shift);

  // 1. Delay = actual check-in time - shift start timing (if check-in is after shift start)
  let delay_by_minutes = 0;
  if (inTime.getTime() > shiftStartTime.getTime()) {
    delay_by_minutes = Math.round((inTime.getTime() - shiftStartTime.getTime()) / (1000 * 60));
  }

  // 4. Extra time = checkout time - shift end time (only positive, no negative values)
  let extra_time_minutes = 0;
  if (outTime.getTime() > shiftEndTime.getTime()) {
    extra_time_minutes = Math.round((outTime.getTime() - shiftEndTime.getTime()) / (1000 * 60));
  }

  // OT: allowed only after end + graceAfter; but counted from shift end
  let ot_hours_decimal = 0;
  const otStartThreshold = new Date(shiftEndTime.getTime() + (shift.graceAfter || 0) * 60 * 1000);
  if (outTime.getTime() > otStartThreshold.getTime()) {
    const otMinutesFromEnd = Math.round((outTime.getTime() - shiftEndTime.getTime()) / (1000 * 60));
    if (otMinutesFromEnd >= MIN_OT_MINUTES) {
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

module.exports = { 
  calculateAttendanceMetrics, 
  getAllShifts, 
  detectShiftForTime,
  isWithinCheckInWindow,
  isWithinCheckOutWindow,
  findShiftByCheckInWindow,
  findShiftForPunchWithGrace,
  getShiftEndWithGrace,
  buildLocalTime,
  buildShiftEndTime
};

