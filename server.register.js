// Dedicated server for Employee Register microservice
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const db = require('./config/db');
const { protect } = require('./middleware/authMiddleware');
const { getFaceEmbedding } = require('./services/faceRecognitionService');
const { triggerEmployeeRegistrationNotification } = require('./services/notificationService');

dotenv.config();

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  req.setTimeout(90000);
  res.setTimeout(90000);
  next();
});
app.use(morgan('dev'));

app.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'register-service' });
});

// Multer config mirroring employeeRoutes.js for register
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadPath = process.env.UPLOAD_PATH || 'uploads/';
      if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
      cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
      cb(null, `emp-${Date.now()}${path.extname(file.originalname)}`);
    }
  }),
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed!'), false);
  }
});

const router = express.Router();

router.post('/register', protect, upload.single('image'), async (req, res) => {
  const startTime = Date.now();
  req.setTimeout(90000);
  res.setTimeout(90000);

  let filePath = null;
  try {
    const { employee_name, department, position, email, phone_number, employee_type, aadhar_last4, employee_code, organization_id } = req.body;

    try {
      await db.query(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'employee_type_enum') THEN
          IF NOT EXISTS (
            SELECT 1 FROM pg_type t 
            JOIN pg_enum e ON t.oid = e.enumtypid 
            WHERE t.typname='employee_type_enum' AND e.enumlabel='Office Staff'
          ) THEN
            ALTER TYPE employee_type_enum ADD VALUE 'Office Staff';
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_type t 
            JOIN pg_enum e ON t.oid = e.enumtypid 
            WHERE t.typname='employee_type_enum' AND e.enumlabel='Factory Staff'
          ) THEN
            ALTER TYPE employee_type_enum ADD VALUE 'Factory Staff';
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_type t 
            JOIN pg_enum e ON t.oid = e.enumtypid 
            WHERE t.typname='employee_type_enum' AND e.enumlabel='Factory Office Staff'
          ) THEN
            ALTER TYPE employee_type_enum ADD VALUE 'Factory Office Staff';
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_type t 
            JOIN pg_enum e ON t.oid = e.enumtypid 
            WHERE t.typname='employee_type_enum' AND e.enumlabel='Intern'
          ) THEN
            ALTER TYPE employee_type_enum ADD VALUE 'Intern';
          END IF;
        END IF;
      END $$;`);
    } catch (e) {
      console.warn('[REGISTER] Enum check/alter warning:', e.message);
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Please upload an image' });
    }

    filePath = req.file.path;
    let imageBuffer;
    try {
      imageBuffer = fs.readFileSync(filePath);
    } catch (_e) {
      return res.status(500).json({ message: 'Error reading uploaded image file' });
    }

    let embedding;
    try {
      embedding = await getFaceEmbedding(imageBuffer);
    } catch (embeddingError) {
      if (filePath) {
        fs.unlink(filePath, () => {});
      }
      return res.status(400).json({
        message: embeddingError.message || 'Error processing face detection'
      });
    }

    if (!embedding) {
      if (filePath) {
        fs.unlink(filePath, () => {});
      }
      return res.status(400).json({ message: 'No face detected in the image' });
    }

    const embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);
    if (!embeddingArray || embeddingArray.length === 0) {
      if (filePath) {
        fs.unlink(filePath, () => {});
      }
      return res.status(400).json({ message: 'No face detected in the image' });
    }

    await db.query(`ALTER TABLE employee_details ADD COLUMN IF NOT EXISTS employee_code TEXT;`);
    await db.query(`ALTER TABLE employee_details ADD COLUMN IF NOT EXISTS aadhar_last4 TEXT;`);
    await db.query(`ALTER TABLE employee_details ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(organization_id);`);

    let finalEmployeeCode = employee_code;
    if (!finalEmployeeCode && aadhar_last4 && /^[0-9]{4}$/.test(aadhar_last4)) {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      finalEmployeeCode = `ANO/${y}${m}/${aadhar_last4}`;
    }

    const insertQuery = `
      INSERT INTO employee_details (employee_name, department, position, email, phone_number, employee_type, aadhar_last4, employee_code, organization_id, face_embedding) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)
      RETURNING employee_id
    `;
    const result = await db.query(insertQuery, [
      employee_name,
      department,
      position,
      email,
      phone_number,
      employee_type,
      aadhar_last4 || null,
      finalEmployeeCode || null,
      organization_id || null,
      `[${embeddingArray.join(',')}]`
    ]);

    const employeeId = result.rows[0].employee_id;

    console.log('[REGISTER] ✅ Employee registered successfully, ID:', employeeId);

    // Get organization name for notification
    let organizationName = '';
    if (organization_id) {
      try {
        const orgResult = await db.query('SELECT organization_name FROM organizations WHERE organization_id = $1', [organization_id]);
        if (orgResult.rows.length > 0) {
          organizationName = orgResult.rows[0].organization_name;
        }
      } catch (orgError) {
        console.error('[REGISTER] Error fetching organization:', orgError);
      }
    }

    // Trigger registration email notification using business local time (e.g. IST)
    const now = new Date();
    const registrationDate = now.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'Asia/Kolkata',
    });
    const registrationTime = now.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata',
    });

    console.log('[REGISTER] 📧 Preparing to send registration notification...');
    console.log('[REGISTER] Employee details:', {
      employee_id: employeeId,
      employee_name,
      email: email || 'NOT PROVIDED',
      organization_name: organizationName
    });
    
    // Don't await - send response immediately and trigger notification in background
    setImmediate(() => {
      triggerEmployeeRegistrationNotification({
        employee_id: employeeId,
        employee_name,
        employee_code: finalEmployeeCode || '',
        department: department || '',
        position: position || '',
        email: email || '',
        phone_number: phone_number || '',
        employee_type: employee_type || '',
        organization_name: organizationName,
        organization_id: organization_id || null,
        registration_date: registrationDate,
        registration_time: registrationTime,
      }).then(result => {
        console.log('[REGISTER] ✅ Notification completed:', result);
      }).catch(err => {
        console.error('[REGISTER] ❌ Notification error:', err);
        console.error('[REGISTER] Error stack:', err.stack);
      });
    });

    res.status(201).json({
      id: employeeId,
      employee_id: employeeId,
      employee_name,
      department,
      position,
      email,
      phone_number,
      employee_type,
      aadhar_last4: aadhar_last4 || null,
      employee_code: finalEmployeeCode || null,
      image_path: req.file.filename,
      message: `Hi ${employee_name}! Employee registered successfully.`
    });
  } catch (error) {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlink(filePath, () => {});
    }
    if (!res.headersSent) {
      res.status(500).json({
        message: 'Error registering employee',
        error: error.message
      });
    }
  }
});

app.use('/api/employees', router);

const { loadModels } = require('./services/faceRecognitionService');

loadModels()
  .then(() => {
    const PORT = process.env.REGISTER_SERVICE_PORT || 5003;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Register Service running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to load models for Register Service:', err);
    process.exit(1);
  });


