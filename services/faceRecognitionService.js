const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const faceapi = require('face-api.js');
const canvas = require('canvas');

faceapi.env.monkeyPatch({
  Canvas: canvas.Canvas,
  Image: canvas.Image,
  ImageData: canvas.ImageData
});

class FaceRecognitionService {
  constructor() {
    this.MODEL_PATH = path.join(__dirname, '../models');
    this.modelsLoaded = false;
    this.loadingPromise = null;
  }

  async loadModels() {
    if (this.modelsLoaded) return;
    if (this.loadingPromise) return this.loadingPromise;
    
    this.loadingPromise = this._loadModelsInternal();
    return this.loadingPromise;
  }

  async _loadModelsInternal() {
    const fs = require('fs');
    const requiredFiles = [
      'tiny_face_detector_model-weights_manifest.json',
      'tiny_face_detector_model-shard1',
      'face_landmark_68_model-weights_manifest.json',
      'face_landmark_68_model-shard1',
      'face_recognition_model-weights_manifest.json',
      'face_recognition_model-shard1',
      'face_recognition_model-shard2'
    ];

    for (const file of requiredFiles) {
      const filePath = require('path').join(this.MODEL_PATH, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Model file missing: ${file}. Please run: npm run download-models`);
      }
    }

    await faceapi.tf.ready();
    await faceapi.nets.tinyFaceDetector.loadFromDisk(this.MODEL_PATH);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(this.MODEL_PATH);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(this.MODEL_PATH);
    this.modelsLoaded = true;
  }

  resizeToCanvas(image, maxWidth = 640) {
    let width = image.width;
    let height = image.height;
    if (width > maxWidth) {
      height = (height * maxWidth) / width;
      width = maxWidth;
    }
    const c = createCanvas(width, height);
    const ctx = c.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);
    return c;
  }

  _getDetectorOptions(inputSize = 320) {
    return new faceapi.TinyFaceDetectorOptions({
      inputSize,
      scoreThreshold: 0.5
    });
  }

  async detectFacesWithDescriptor(srcCanvas) {
    const opts = this._getDetectorOptions(320);
    return faceapi
      .detectAllFaces(srcCanvas, opts)
      .withFaceLandmarks()
      .withFaceDescriptors();
  }

  async detectFaceOnly(srcCanvas) {
    const opts = this._getDetectorOptions(224);
    return faceapi.detectSingleFace(srcCanvas, opts);
  }

  async getFaceEmbedding(imageBuffer) {
    if (!this.modelsLoaded) {
      await this.loadModels();
    }
    const img = await loadImage(imageBuffer);
    const c = this.resizeToCanvas(img);
    const detections = await this.detectFacesWithDescriptor(c);
    if (!detections || detections.length === 0) {
      throw new Error('No faces detected in the image');
    }
    return detections[0].descriptor;
  }

  async getFaceBoxNormalized(imageBuffer) {
    if (!this.modelsLoaded) {
      await this.loadModels();
    }
    const img = await loadImage(imageBuffer);
    const c = this.resizeToCanvas(img, 320);
    const detection = await this.detectFaceOnly(c);
    if (!detection) return null;
    
    const box = detection.box;
    return {
      x: box.x / c.width,
      y: box.y / c.height,
      width: box.width / c.width,
      height: box.height / c.height
    };
  }
}

const faceRecognitionService = new FaceRecognitionService();

module.exports = {
  loadModels: () => faceRecognitionService.loadModels(),
  getFaceEmbedding: (imageBuffer) => faceRecognitionService.getFaceEmbedding(imageBuffer),
  getFaceBoxNormalized: (imageBuffer) => faceRecognitionService.getFaceBoxNormalized(imageBuffer)
};
