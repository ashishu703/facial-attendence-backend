/**
 * Attendance Configuration Service
 * 
 * Centralized configuration for attendance system rules.
 * All values are configurable via environment variables with sensible defaults.
 */

class AttendanceConfigService {
  constructor() {
    // Duplicate Punch Window (in minutes)
    // Any new punch within this time from previous punch is considered duplicate/noise
    this.DUPLICATE_WINDOW_MIN = parseInt(
      process.env.DUPLICATE_WINDOW_MIN || '5',
      10
    );

    // Minimum Session Duration (in minutes)
    // Any IN-OUT session shorter than this is invalid for working hours calculation
    this.MIN_SESSION_MIN = parseInt(
      process.env.MIN_SESSION_MIN || '30',
      10
    );

    // Full Day Threshold (in hours)
    // Employee must work at least this many hours to be considered "Full Day"
    this.FULL_DAY_THRESHOLD_HOURS = parseFloat(
      process.env.FULL_DAY_THRESHOLD_HOURS || '7.0'
    );

    // Half Day Threshold (in hours)
    // Employee must work at least this many hours to be considered "Half Day"
    this.HALF_DAY_THRESHOLD_HOURS = parseFloat(
      process.env.HALF_DAY_THRESHOLD_HOURS || '4.0'
    );

    // Maximum Day Duration (in hours)
    // Clamp any day's total working time to this max duration
    this.MAX_DAY_DURATION_HOURS = parseFloat(
      process.env.MAX_DAY_DURATION_HOURS || '14.0'
    );

    // Minimum OT Minutes (existing, kept for compatibility)
    this.MIN_OT_MINUTES = parseInt(
      process.env.MIN_OT_MINUTES || '15',
      10
    );

    // Local Time Offset (existing, kept for compatibility)
    this.LOCAL_TIME_OFFSET_MINUTES = parseInt(
      process.env.LOCAL_TIME_OFFSET_MINUTES || '330',
      10
    );

    // Daily Closing Job Configuration
    // Buffer time (in minutes) to add after last presence detection for forgot checkout
    this.FORGOT_CHECKOUT_BUFFER_MIN = parseInt(
      process.env.FORGOT_CHECKOUT_BUFFER_MIN || '10',
      10
    );

    // Maximum OT Limit (in hours) for forgot checkout calculation
    this.MAX_OT_LIMIT_HOURS = parseFloat(
      process.env.MAX_OT_LIMIT_HOURS || '4.0'
    );

    // Daily Closing Job Run Time (24-hour format, e.g., "23:30" for 11:30 PM)
    this.DAILY_CLOSING_JOB_TIME = process.env.DAILY_CLOSING_JOB_TIME || '23:30';
  }

  /**
   * Get all configuration values (useful for debugging/admin)
   */
  getAllConfig() {
    return {
      DUPLICATE_WINDOW_MIN: this.DUPLICATE_WINDOW_MIN,
      MIN_SESSION_MIN: this.MIN_SESSION_MIN,
      FULL_DAY_THRESHOLD_HOURS: this.FULL_DAY_THRESHOLD_HOURS,
      HALF_DAY_THRESHOLD_HOURS: this.HALF_DAY_THRESHOLD_HOURS,
      MAX_DAY_DURATION_HOURS: this.MAX_DAY_DURATION_HOURS,
      MIN_OT_MINUTES: this.MIN_OT_MINUTES,
      LOCAL_TIME_OFFSET_MINUTES: this.LOCAL_TIME_OFFSET_MINUTES,
      FORGOT_CHECKOUT_BUFFER_MIN: this.FORGOT_CHECKOUT_BUFFER_MIN,
      MAX_OT_LIMIT_HOURS: this.MAX_OT_LIMIT_HOURS,
      DAILY_CLOSING_JOB_TIME: this.DAILY_CLOSING_JOB_TIME
    };
  }
}

const attendanceConfigService = new AttendanceConfigService();

module.exports = attendanceConfigService;

