// Import required dependencies
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

// Load environment variables from .env file
dotenv.config();

// Initialize Express app
const app = express();

// Apply security headers with helmet
app.use(helmet());

// Apply CORS to allow requests from frontend
app.use(cors());

// Parse JSON request bodies
app.use(express.json({ limit: '10mb' }));

// Increase timeout for long-running requests (face recognition)
app.use((req, res, next) => {
  req.setTimeout(60000); // 60 seconds
  res.setTimeout(60000); // 60 seconds
  next();
});

// Apply request logging with morgan
app.use(morgan('dev'));

// Health check route
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Auth routes
app.use('/api/auth', require('./routes/authRoutes'));

// Employee routes
app.use('/api/employees', require('./routes/employeeRoutes'));

// Attendance report/download routes stay on monolith; /mark is handled by Mark microservice
app.use('/api/attendance', require('./routes/attendanceReportRoutes'));
// Shift routes
app.use('/api/shifts', require('./routes/shiftRoutes'));
// Organization routes
app.use('/api/organizations', require('./routes/organizationRoutes'));
// Email configuration routes
app.use('/api/email-config', require('./routes/emailConfigRoutes'));
// WhatsApp configuration routes
app.use('/api/whatsapp-config', require('./routes/whatsappConfigRoutes'));
// Report routes
app.use('/api/reports', require('./routes/reportRoutes'));

// Load face recognition models and start server
const { loadModels } = require('./services/faceRecognitionService');
const { processAbsentMarking } = require('./services/absentMarkingService');
const { clearOldDetections } = require('./services/presenceDetectionService');
const { processYesterday: processDailyClosing } = require('./services/dailyClosingService');
const { consolidateYesterday: consolidateDailyAttendance } = require('./services/dailyConsolidationService');
const { ensureColumns } = require('./services/dbMigrationService');

// Load models before starting the server
loadModels()
  .then(async () => {
    // Ensure database columns exist
    try {
      await ensureColumns();
      console.log('[SERVER] ✅ Database migration completed');
    } catch (error) {
      console.error('[SERVER] ⚠️ Database migration error (may be safe if columns already exist):', error.message);
    }

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
      
      // Run absent marking every hour
      setInterval(async () => {
        try {
          await processAbsentMarking();
          await clearOldDetections();
        } catch (error) {
          console.error('Error in scheduled absent marking:', error);
        }
      }, 60 * 60 * 1000);
      
      // Daily closing job - runs once per day at configured time
      const scheduleDailyClosingJob = () => {
        const attendanceConfig = require('./services/attendanceConfigService');
        const closingTime = attendanceConfig.DAILY_CLOSING_JOB_TIME || '23:30';
        const [hour, minute] = closingTime.split(':').map(Number);
        
        const now = new Date();
        const scheduledTime = new Date();
        scheduledTime.setHours(hour, minute, 0, 0);
        
        // If scheduled time has passed today, schedule for tomorrow
        if (scheduledTime <= now) {
          scheduledTime.setDate(scheduledTime.getDate() + 1);
        }
        
        const msUntilScheduled = scheduledTime.getTime() - now.getTime();
        
        console.log(`[SERVER] Daily closing job scheduled for ${scheduledTime.toISOString()}`);
        
        setTimeout(async () => {
          console.log('[SERVER] Running daily closing job...');
          try {
            await processDailyClosing();
            await consolidateDailyAttendance();
            console.log('[SERVER] ✅ Daily closing job completed');
          } catch (error) {
            console.error('[SERVER] ❌ Error in daily closing job:', error);
          }
          
          // Schedule next run (24 hours later)
          scheduleDailyClosingJob();
        }, msUntilScheduled);
      };
      
      // Start daily closing job scheduler
      scheduleDailyClosingJob();
      
      // Run immediately on startup (for testing/debugging)
      setTimeout(async () => {
        try {
          await processAbsentMarking();
          await clearOldDetections();
        } catch (error) {
          console.error('Error in initial absent marking:', error);
        }
      }, 5000);
    });
  })
  .catch(error => {
    console.error('Failed to load models:', error);
    process.exit(1);
  });
