const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, '../models');

const requiredFiles = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model-shard1',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1',
  'face_recognition_model-shard2'
];

function verifyModels() {
  console.log('Verifying model files...\n');
  
  if (!fs.existsSync(MODELS_DIR)) {
    console.error('❌ Models directory does not exist:', MODELS_DIR);
    console.log('\n💡 Run: npm run download-models');
    process.exit(1);
  }

  let allExist = true;
  let totalSize = 0;

  for (const file of requiredFiles) {
    const filePath = path.join(MODELS_DIR, file);
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const sizeKB = (stats.size / 1024).toFixed(2);
      totalSize += stats.size;
      console.log(`  ✓ ${file} (${sizeKB} KB)`);
    } else {
      console.log(`  ✗ ${file} MISSING`);
      allExist = false;
    }
  }

  console.log(`\nTotal size: ${(totalSize / (1024 * 1024)).toFixed(2)} MB`);

  if (allExist) {
    console.log('\n✅ All required model files are present!');
    console.log('✅ Models are ready for loading.');
    return true;
  } else {
    console.log('\n❌ Some model files are missing!');
    console.log('💡 Run: npm run download-models');
    return false;
  }
}

if (!verifyModels()) {
  process.exit(1);
}
