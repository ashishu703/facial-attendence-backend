const axios = require('axios');
const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, '../models');
const BASE_URL = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights';

const models = [
  {
    name: 'tiny_face_detector',
    files: [
      'tiny_face_detector_model-weights_manifest.json',
      'tiny_face_detector_model-shard1'
    ]
  },
  {
    name: 'face_landmark_68',
    files: [
      'face_landmark_68_model-weights_manifest.json',
      'face_landmark_68_model-shard1'
    ]
  },
  {
    name: 'face_recognition',
    files: [
      'face_recognition_model-weights_manifest.json',
      'face_recognition_model-shard1',
      'face_recognition_model-shard2'
    ]
  }
];

async function downloadFile(url, filePath) {
  try {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      timeout: 60000
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        const stats = fs.statSync(filePath);
        resolve({ size: stats.size });
      });
      writer.on('error', reject);
      response.data.on('error', reject);
    });
  } catch (error) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    throw error;
  }
}

async function downloadModels() {
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    console.log(`Created models directory: ${MODELS_DIR}\n`);
  }

  console.log('Starting model download...\n');
  console.log(`Downloading from: ${BASE_URL}\n`);

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (const model of models) {
    console.log(`📦 Downloading ${model.name} model...`);
    
    for (const file of model.files) {
      const url = `${BASE_URL}/${file}`;
      const filePath = path.join(MODELS_DIR, file);
      
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.size > 0) {
          const sizeKB = (stats.size / 1024).toFixed(2);
          console.log(`  ✓ ${file} already exists (${sizeKB} KB), skipping...`);
          skipCount++;
          continue;
        } else {
          console.log(`  ⚠ ${file} exists but is empty, re-downloading...`);
          fs.unlinkSync(filePath);
        }
      }

      try {
        process.stdout.write(`  ⬇ Downloading ${file}... `);
        const result = await downloadFile(url, filePath);
        const sizeMB = (result.size / (1024 * 1024)).toFixed(2);
        console.log(`✓ (${sizeMB} MB)`);
        successCount++;
      } catch (error) {
        console.log(`✗`);
        if (error.response) {
          console.error(`  ❌ HTTP ${error.response.status}: ${error.response.statusText}`);
        } else {
          console.error(`  ❌ Error: ${error.message}`);
        }
        console.error(`  URL: ${url}`);
        failCount++;
      }
    }
    
    console.log('');
  }

  console.log('\n' + '='.repeat(50));
  console.log('Download Summary:');
  console.log(`  ✓ Successfully downloaded: ${successCount} files`);
  console.log(`  ⊘ Skipped (already exist): ${skipCount} files`);
  console.log(`  ✗ Failed: ${failCount} files`);
  console.log('='.repeat(50));

  if (failCount > 0) {
    console.log('\n❌ Some files failed to download.');
    console.log('\n💡 Alternative: Download manually from:');
    console.log('   https://github.com/justadudewhohacks/face-api.js/tree/master/weights');
    console.log('\nRequired files:');
    models.forEach(m => {
      m.files.forEach(f => console.log(`   - ${f}`));
    });
    process.exit(1);
  }

  console.log('\n✅ Verifying downloaded files...\n');
  
  const allFiles = models.flatMap(m => m.files);
  let allExist = true;
  let totalSize = 0;
  
  for (const file of allFiles) {
    const filePath = path.join(MODELS_DIR, file);
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const sizeKB = (stats.size / 1024).toFixed(2);
      totalSize += stats.size;
      if (stats.size > 0) {
        console.log(`  ✓ ${file} (${sizeKB} KB)`);
      } else {
        console.log(`  ✗ ${file} is empty (0 bytes)`);
        allExist = false;
      }
    } else {
      console.log(`  ✗ ${file} MISSING`);
      allExist = false;
    }
  }
  
  console.log(`\nTotal size: ${(totalSize / (1024 * 1024)).toFixed(2)} MB`);
  
  if (allExist) {
    console.log('\n✅ All model files are present and ready!');
    console.log('✅ You can now start the server with: npm start');
  } else {
    console.log('\n❌ Some files are missing or corrupted.');
    process.exit(1);
  }
}

downloadModels().catch(error => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});
