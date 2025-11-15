const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const faceapi = require('face-api.js');
const canvas = require('canvas');

faceapi.env.monkeyPatch({
  Canvas: canvas.Canvas,
  Image: canvas.Image,
  ImageData: canvas.ImageData
});

const MODEL_PATH = path.join(__dirname, '../models');
let useTinyFaceDetector = false;

async function loadModels() {
  try {
    console.log('Loading face-api models...');
    await faceapi.tf.ready();

    try {
      await faceapi.nets.tinyFaceDetector.loadFromDisk(MODEL_PATH);
      useTinyFaceDetector = true;
      console.log('✓ TinyFaceDetector loaded (faster model)');
    } catch (_) {
      console.log('⚠ TinyFaceDetector not found, using SSD MobileNet (slower but available)');
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_PATH);
      useTinyFaceDetector = false;
    }

    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_PATH);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_PATH);

    console.log('Face-API models loaded successfully.');
    console.log(
      useTinyFaceDetector
        ? 'Using TinyFaceDetector - Expected: 5-8 seconds per request'
        : 'Using SSD MobileNet with optimizations - Expected: 8-12 seconds per request'
    );
  } catch (error) {
    console.error('Error loading models:', error);
    throw error;
  }
}

function resizeToCanvas(image) {
  const MAX_WIDTH = 640;
  let width = image.width;
  let height = image.height;
  if (width > MAX_WIDTH) {
    height = (height * MAX_WIDTH) / width;
    width = MAX_WIDTH;
  }
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);
  return c;
}

async function detectFacesWithDescriptor(srcCanvas) {
  if (useTinyFaceDetector) {
    const opts = new faceapi.TinyFaceDetectorOptions({
      inputSize: 320,
      scoreThreshold: 0.5
    });
    return faceapi
      .detectAllFaces(srcCanvas, opts)
      .withFaceLandmarks()
      .withFaceDescriptors();
  }
  const opts = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });
  return faceapi
    .detectAllFaces(srcCanvas, opts)
    .withFaceLandmarks()
    .withFaceDescriptors();
}

async function getFaceEmbedding(imageBuffer) {
  try {
    const img = await loadImage(imageBuffer);
    const c = resizeToCanvas(img);
    const detections = await detectFacesWithDescriptor(c);
    if (!detections || detections.length === 0) {
      throw new Error('No faces detected in the image');
    }
    return detections[0].descriptor;
  } catch (error) {
    console.error('Error in getFaceEmbedding:', error);
    throw error;
  }
}

// Lightweight face detection - NO landmarks, NO descriptors (MUCH FASTER!)
async function detectFaceOnly(srcCanvas) {
  if (useTinyFaceDetector) {
    const opts = new faceapi.TinyFaceDetectorOptions({
      inputSize: 224, // Reduced from 320 for faster processing
      scoreThreshold: 0.5
    });
    return faceapi.detectSingleFace(srcCanvas, opts); // detectSingleFace is faster than detectAllFaces
  }
  const opts = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });
  return faceapi.detectSingleFace(srcCanvas, opts);
}

async function getFaceBoxNormalized(imageBuffer) {
  try {
    const img = await loadImage(imageBuffer);
    
    // Use smaller canvas for faster detection
    const MAX_WIDTH = 320; // Reduced from 640
    let width = img.width;
    let height = img.height;
    if (width > MAX_WIDTH) {
      height = (height * MAX_WIDTH) / width;
      width = MAX_WIDTH;
    }
    const c = createCanvas(width, height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    
    // Use lightweight detection (no landmarks, no descriptors)
    const detection = await detectFaceOnly(c);
    
    if (!detection) {
      return null;
    }
    
    const box = detection.box;
    const norm = {
      x: box.x / c.width,
      y: box.y / c.height,
      width: box.width / c.width,
      height: box.height / c.height,
    };
    return norm;
  } catch (error) {
    console.error('Error in getFaceBoxNormalized:', error);
    return null;
  }
}

module.exports = { loadModels, getFaceEmbedding, getFaceBoxNormalized };

