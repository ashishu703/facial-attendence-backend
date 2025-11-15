// Dedicated server for Face Verify microservice
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const { protect } = require('./middleware/authMiddleware');
const { getFaceBoxNormalized } = require('./services/faceRecognitionService');

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
  res.status(200).json({ status: 'ok', service: 'verify-service' });
});

// Minimal router replicating existing verify-face logic from employeeRoutes.js
const router = express.Router();
const memoryStorage = multer.memoryStorage();
const uploadToMemory = multer({
  storage: memoryStorage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed!'), false);
  }
});

router.post('/verify-face', protect, uploadToMemory.single('image'), async (req, res) => {
  const startTime = Date.now();
  
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'No image file provided or file upload failed.'
    });
  }
  
  try {
    console.log(`[Verify] Processing image (${(req.file.size / 1024).toFixed(2)} KB)...`);
    
    const box = await getFaceBoxNormalized(req.file.buffer);
    const processingTime = Date.now() - startTime;
    
    console.log(`[Verify] ${box ? '✓ Face detected' : '✗ No face'} (${processingTime}ms)`);
    
    return res.status(200).json({
      success: !!box,
      box,
      processingTime,
      message: box ? 'Face detected successfully.' : 'No face detected in the image.'
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`[Verify] ERROR after ${processingTime}ms:`, error.message);
    
    return res.status(500).json({
      success: false,
      message: 'Error processing face detection',
      error: error.message
    });
  }
});

app.use('/api/employees', router);

const { loadModels } = require('./services/faceRecognitionService');

loadModels()
  .then(() => {
    const PORT = process.env.VERIFY_SERVICE_PORT || 5002;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Verify Service running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to load models for Verify Service:', err);
    process.exit(1);
  });


