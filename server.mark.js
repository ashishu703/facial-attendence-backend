// Dedicated server for Attendance Mark microservice
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  req.setTimeout(60000);
  res.setTimeout(60000);
  next();
});
app.use(morgan('dev'));

app.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'mark-service' });
});

// Reuse existing attendance routes (contains /mark and others; contract unchanged)
app.use('/api/attendance', require('./routes/attendanceRoutes'));

const { loadModels } = require('./services/faceRecognitionService');
const { autoCheckoutOverdue } = require('./services/autoCheckoutService');

loadModels()
  .then(() => {
    const PORT = process.env.MARK_SERVICE_PORT || process.env.PORT || 5001;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Mark Service running on port ${PORT}`);
      setInterval(() => {
        autoCheckoutOverdue().catch(() => {});
      }, 5 * 60 * 1000); // every 5 minutes
    });
  })
  .catch((err) => {
    console.error('Failed to load models for Mark Service:', err);
    process.exit(1);
  });


