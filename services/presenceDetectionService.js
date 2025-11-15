const db = require('../config/db');

const PRESENCE_DETECTION_TABLE = 'presence_detections';

const initPresenceTable = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${PRESENCE_DETECTION_TABLE} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL,
        detection_time TIMESTAMP NOT NULL,
        date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_presence_employee_date 
      ON ${PRESENCE_DETECTION_TABLE}(employee_id, date, detection_time);
    `);
  } catch (error) {
    console.error('Error initializing presence detection table:', error);
  }
};

const recordPresenceDetection = async (employeeId, detectionTime, date) => {
  try {
    await initPresenceTable();
    await db.query(
      `INSERT INTO ${PRESENCE_DETECTION_TABLE} (employee_id, detection_time, date)
       VALUES ($1, $2, $3)`,
      [employeeId, detectionTime, date]
    );
  } catch (error) {
    console.error('Error recording presence detection:', error);
  }
};

const checkPresenceRequirement = async (employeeId, date, presenceTime, presenceCount, presenceWindow) => {
  try {
    await initPresenceTable();
    
    const now = new Date();
    const windowStart = new Date(now.getTime() - presenceWindow * 1000);
    
    const { rows } = await db.query(
      `SELECT detection_time FROM ${PRESENCE_DETECTION_TABLE}
       WHERE employee_id = $1 AND date = $2 
       AND detection_time >= $3
       ORDER BY detection_time DESC`,
      [employeeId, date, windowStart]
    );
    
    if (rows.length === 0) return false;
    
    if (rows.length >= presenceCount) {
      return true;
    }
    
    if (rows.length >= 2) {
      const firstDetection = new Date(rows[rows.length - 1].detection_time);
      const lastDetection = new Date(rows[0].detection_time);
      const continuousTime = (lastDetection.getTime() - firstDetection.getTime()) / 1000;
      
      if (continuousTime >= presenceTime) {
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error('Error checking presence requirement:', error);
    return false;
  }
};

const clearOldDetections = async (date) => {
  try {
    await initPresenceTable();
    const cutoffTime = new Date();
    cutoffTime.setDate(cutoffTime.getDate() - 7);
    
    await db.query(
      `DELETE FROM ${PRESENCE_DETECTION_TABLE} WHERE date < $1`,
      [cutoffTime.toISOString().split('T')[0]]
    );
  } catch (error) {
    console.error('Error clearing old detections:', error);
  }
};

module.exports = {
  recordPresenceDetection,
  checkPresenceRequirement,
  clearOldDetections
};

