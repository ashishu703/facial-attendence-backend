const db = require('../config/db');

class PresenceDetectionService {
  constructor() {
    this.TABLE_NAME = 'presence_detections';
    this.initialized = false;
  }

  async initTable() {
    if (this.initialized) return;
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${this.TABLE_NAME} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          employee_id UUID NOT NULL,
          detection_time TIMESTAMP NOT NULL,
          date DATE NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_presence_employee_date 
        ON ${this.TABLE_NAME}(employee_id, date, detection_time);
      `);
      this.initialized = true;
    } catch (error) {
      console.error('Error initializing presence detection table:', error);
    }
  }

  async recordPresenceDetection(employeeId, detectionTime, date) {
    try {
      await this.initTable();
      await db.query(
        `INSERT INTO ${this.TABLE_NAME} (employee_id, detection_time, date)
         VALUES ($1, $2, $3)`,
        [employeeId, detectionTime, date]
      );
    } catch (error) {
      console.error('Error recording presence detection:', error);
    }
  }

  async checkPresenceRequirement(employeeId, date, presenceTime, presenceCount, presenceWindow) {
    try {
      await this.initTable();
      
      const now = new Date();
      const windowStart = new Date(now.getTime() - presenceWindow * 1000);
      
      const { rows } = await db.query(
        `SELECT detection_time FROM ${this.TABLE_NAME}
         WHERE employee_id = $1 AND date = $2 
         AND detection_time >= $3
         ORDER BY detection_time DESC`,
        [employeeId, date, windowStart]
      );
      
      if (rows.length === 0) return false;
      if (rows.length >= presenceCount) return true;
      
      if (rows.length >= 2) {
        const firstDetection = new Date(rows[rows.length - 1].detection_time);
        const lastDetection = new Date(rows[0].detection_time);
        const continuousTime = (lastDetection.getTime() - firstDetection.getTime()) / 1000;
        return continuousTime >= presenceTime;
      }
      
      return false;
    } catch (error) {
      console.error('Error checking presence requirement:', error);
      return false;
    }
  }

  async clearOldDetections() {
    try {
      await this.initTable();
      const cutoffTime = new Date();
      cutoffTime.setDate(cutoffTime.getDate() - 7);
      
      await db.query(
        `DELETE FROM ${this.TABLE_NAME} WHERE date < $1`,
        [cutoffTime.toISOString().split('T')[0]]
      );
    } catch (error) {
      console.error('Error clearing old detections:', error);
    }
  }
}

const presenceDetectionService = new PresenceDetectionService();

module.exports = {
  recordPresenceDetection: (employeeId, detectionTime, date) =>
    presenceDetectionService.recordPresenceDetection(employeeId, detectionTime, date),
  checkPresenceRequirement: (employeeId, date, presenceTime, presenceCount, presenceWindow) =>
    presenceDetectionService.checkPresenceRequirement(employeeId, date, presenceTime, presenceCount, presenceWindow),
  clearOldDetections: () =>
    presenceDetectionService.clearOldDetections()
};
