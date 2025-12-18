const db = require('../config/db');
const { getAllShifts, detectShiftForTime, getShiftEndWithGrace } = require('./attendanceLogicService');
const { calculateAttendanceMetrics } = require('./attendanceLogicService');

class AutoCheckoutService {
  /**
   * Auto checkout service - DISABLED
   * 
   * NOTE: Changed behavior - No longer automatically sets checkout time.
   * Employees who didn't check out will remain with null checkout time
   * and will be marked as "Absent" by the consolidation service.
   */
  async autoCheckoutOverdue() {
    try {
      // Do NOT automatically set checkout time
      // Leave checkout as null so consolidation service can mark as "Absent"
      console.log(
        `[AUTO-CHECKOUT] Auto checkout disabled. ` +
        `Employees without checkout will be marked as "Not checked out" and "Absent" by consolidation service`
      );
      
      // Return early without processing
      return { processed: 0, reason: 'auto_checkout_disabled' };
    } catch (error) {
      console.error('autoCheckoutOverdue error:', error);
      return { processed: 0, reason: 'error', error: error.message };
    }
  }
}

const autoCheckoutService = new AutoCheckoutService();

module.exports = { 
  autoCheckoutOverdue: () => autoCheckoutService.autoCheckoutOverdue() 
};
