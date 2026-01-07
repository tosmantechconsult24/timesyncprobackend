/**
 * ZKTeco SDK Native Wrapper - Windows DLL Interface
 * Bridges C++ SDK functions to Node.js
 * 
 * Based on ZKTeco v10.0 libzkfp.h API:
 * - ZKFPM_Init() / ZKFPM_Terminate()
 * - ZKFPM_OpenDevice() / ZKFPM_CloseDevice()
 * - ZKFPM_AcquireFingerprint() - Capture + template generation
 * - ZKFPM_GenRegTemplate() - Merge 3 samples into registration template
 * - ZKFPM_DBMatch() - Compare 2 templates (1:1 verification)
 * - ZKFPM_DBIdentify() - Search in database (1:N identification)
 * - ZKFPM_DBAdd() / ZKFPM_DBDel() - Database management
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

let ffi = null;
let ref = null;
let zktecoLib = null;
let sdkAvailable = false;

// Try to load native FFI bindings
console.log('[ZKTeco] Attempting to load native SDK...');

try {
  // Check if ffi-napi is installed
  try {
    ffi = require('ffi-napi');
    ref = require('ref-napi');
    console.log('[ZKTeco] Native modules (ffi-napi, ref-napi) found');
  } catch (e) {
    throw new Error('Native modules not installed');
  }

  // Define types
  const voidPtr = ref.refType(ref.types.void);
  const uintPtr = ref.refType(ref.types.uint);
  const ucharPtr = ref.refType(ref.types.uchar);

  // Try to load ZKTeco DLL from multiple possible locations
  const dllSearchPaths = [
    'libzkfp',                                          // System PATH
    path.join(__dirname, '../../../bridge/Windows'),    // Local SDK bridge
    'C:\\Windows\\System32\\libzkfp',                   // System32
    'C:\\Program Files\\ZKTeco\\SDK\\libzkfp',        // Standard install
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'ZKTeco\\SDK\\libzkfp'),
  ];

  let dllLoaded = false;
  let lastError = null;

  for (const dllPath of dllSearchPaths) {
    try {
      zktecoLib = ffi.Library(dllPath, {
        // Initialization
        ZKFPM_Init: ['int', []],
        ZKFPM_Terminate: ['int', []],
        ZKFPM_GetDeviceCount: ['int', []],
        ZKFPM_OpenDevice: [voidPtr, ['int']],
        ZKFPM_CloseDevice: ['int', [voidPtr]],
        ZKFPM_AcquireFingerprint: ['int', [voidPtr, ucharPtr, 'uint', ucharPtr, uintPtr]],
        ZKFPM_DBInit: [voidPtr, []],
        ZKFPM_DBFree: ['int', [voidPtr]],
        ZKFPM_DBClear: ['int', [voidPtr]],
        ZKFPM_GenRegTemplate: ['int', [voidPtr, ucharPtr, ucharPtr, ucharPtr, ucharPtr, uintPtr]],
        ZKFPM_DBAdd: ['int', [voidPtr, 'uint', ucharPtr, 'uint']],
        ZKFPM_DBDel: ['int', [voidPtr, 'uint']],
        ZKFPM_DBMatch: ['int', [voidPtr, ucharPtr, 'uint', ucharPtr, 'uint']],
        ZKFPM_DBIdentify: ['int', [voidPtr, ucharPtr, 'uint', ref.refType(ref.types.uint), ref.refType(ref.types.uint)]],
        ZKFPM_BlobToBase64: ['int', [ucharPtr, 'uint', 'string', 'uint']],
        ZKFPM_Base64ToBlob: ['int', ['string', ucharPtr, 'uint']],
      });
      
      console.log('[ZKTeco] ✓ SDK loaded from:', dllPath);
      sdkAvailable = true;
      dllLoaded = true;
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!dllLoaded) {
    throw new Error(`DLL not found in any path. Last error: ${lastError?.message}`);
  }

} catch (error) {
  console.error('[ZKTeco] ❌ SDK initialization failed:', error.message);
  console.error('[ZKTeco]');
  console.error('[ZKTeco] SETUP REQUIRED. To enable USB fingerprint scanner:');
  console.error('[ZKTeco]');
  console.error('[ZKTeco] 1. Install Visual Studio Build Tools with C++ support:');
  console.error('[ZKTeco]    Download from: https://visualstudio.microsoft.com/downloads/');
  console.error('[ZKTeco]    Select "C++ build tools" or "Desktop development with C++"');
  console.error('[ZKTeco]');
  console.error('[ZKTeco] 2. Then install native dependencies:');
  console.error('[ZKTeco]    cd c:\\time-attendance-system\\backend');
  console.error('[ZKTeco]    npm install ffi-napi ref-napi');
  console.error('[ZKTeco]');
  console.error('[ZKTeco] 3. Ensure libzkfp.dll is accessible:');
  console.error('[ZKTeco]    Copy to C:\\Windows\\System32\\libzkfp.dll');
  console.error('[ZKTeco]    Or add SDK path to System PATH');
  console.error('[ZKTeco]');
  console.error('[ZKTeco] See ZKTECO_SETUP_INSTRUCTIONS.md for detailed steps');
  
  zktecoLib = null;
  sdkAvailable = false;
}

// Error codes from libzkfperrdef.h
const ZKFP_ERR_OK = 0;
const ZKFP_ERR_TIMEOUT = 1;
const ZKFP_ERR_INVALID_PARAM = 2;
const ZKFP_ERR_INVALID_HANDLE = 3;
const ZKFP_ERR_OPEN_DEVICE = 4;
const ZKFP_ERR_OPEN_FAILED = 5;

class ZKTecoFingerprintScanner {
  constructor() {
    this.deviceHandle = null;
    this.dbHandle = null;
    this.isInitialized = false;
    this.maxTemplateSize = 2048;
    this.maxImageSize = 320 * 480; // Typical fingerprint image size
  }

  /**
   * Initialize SDK and device
   */
  async init() {
    try {
      if (!zktecoLib) {
        throw new Error('ZKTeco SDK not loaded');
      }

      // Initialize SDK
      const ret = zktecoLib.ZKFPM_Init();
      if (ret !== ZKFP_ERR_OK) {
        throw new Error(`ZKFPM_Init failed: ${ret}`);
      }

      // Create database cache
      this.dbHandle = zktecoLib.ZKFPM_DBInit();
      if (!this.dbHandle) {
        throw new Error('Failed to create database cache');
      }

      this.isInitialized = true;
      console.log('[ZKTeco] SDK initialized successfully');
      return true;
    } catch (error) {
      console.error('[ZKTeco] Initialization error:', error.message);
      return false;
    }
  }

  /**
   * Get available device count
   */
  getDeviceCount() {
    if (!zktecoLib) return 0;
    try {
      const count = zktecoLib.ZKFPM_GetDeviceCount();
      return Math.max(0, count);
    } catch (error) {
      console.error('[ZKTeco] Error getting device count:', error.message);
      return 0;
    }
  }

  /**
   * Open fingerprint device
   */
  openDevice(deviceIndex = 0) {
    if (!zktecoLib) return false;
    try {
      const handle = zktecoLib.ZKFPM_OpenDevice(deviceIndex);
      if (!handle) {
        throw new Error(`Failed to open device at index ${deviceIndex}`);
      }
      this.deviceHandle = handle;
      console.log('[ZKTeco] Device opened successfully');
      return true;
    } catch (error) {
      console.error('[ZKTeco] Error opening device:', error.message);
      return false;
    }
  }

  /**
   * Close device and cleanup
   */
  closeDevice() {
    if (!zktecoLib || !this.deviceHandle) return;
    try {
      zktecoLib.ZKFPM_CloseDevice(this.deviceHandle);
      this.deviceHandle = null;
      console.log('[ZKTeco] Device closed');
    } catch (error) {
      console.error('[ZKTeco] Error closing device:', error.message);
    }
  }

  /**
   * Terminate SDK
   */
  terminate() {
    if (!zktecoLib || !this.isInitialized) return;
    try {
      if (this.dbHandle) {
        zktecoLib.ZKFPM_DBFree(this.dbHandle);
        this.dbHandle = null;
      }
      zktecoLib.ZKFPM_Terminate();
      this.isInitialized = false;
      console.log('[ZKTeco] SDK terminated');
    } catch (error) {
      console.error('[ZKTeco] Error terminating SDK:', error.message);
    }
  }

  /**
   * Capture fingerprint from device
   * Returns: { template: Buffer, quality: number }
   */
  async captureFingerprint() {
    if (!zktecoLib || !this.deviceHandle) {
      throw new Error('Device not initialized');
    }

    try {
      // Allocate buffers
      const imgBuf = Buffer.alloc(this.maxImageSize);
      const templateBuf = Buffer.alloc(this.maxTemplateSize);
      const templateLenRef = ref.alloc('uint', this.maxTemplateSize);

      // Call SDK capture function
      // This blocks until fingerprint is detected and processed
      const ret = zktecoLib.ZKFPM_AcquireFingerprint(
        this.deviceHandle,
        imgBuf,
        imgBuf.length,
        templateBuf,
        templateLenRef
      );

      if (ret !== ZKFP_ERR_OK) {
        throw new Error(`ZKFPM_AcquireFingerprint failed: ${ret}`);
      }

      const templateLen = templateLenRef.deref();
      const template = templateBuf.slice(0, templateLen);

      return {
        success: true,
        template: template,
        imageBuffer: imgBuf,
        quality: 95, // SDK returns reasonable quality
      };
    } catch (error) {
      console.error('[ZKTeco] Capture error:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Enroll fingerprint (combine 3 samples)
   * Returns: { template: Buffer, quality: number }
   */
  async enrollFingerprint(numSamples = 3) {
    if (!zktecoLib || !this.dbHandle) {
      throw new Error('SDK not initialized');
    }

    try {
      const samples = [];

      // Capture multiple samples
      for (let i = 0; i < numSamples; i++) {
        console.log(`[ZKTeco] Capturing sample ${i + 1}/${numSamples}...`);
        const result = await this.captureFingerprint();

        if (!result.success) {
          throw new Error(`Failed to capture sample ${i + 1}: ${result.error}`);
        }

        samples.push(result.template);

        // Wait between samples
        if (i < numSamples - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // Merge templates using SDK
      const templateBuf = Buffer.alloc(this.maxTemplateSize);
      const templateLenRef = ref.alloc('uint', this.maxTemplateSize);

      let ret;
      if (numSamples === 3) {
        ret = zktecoLib.ZKFPM_GenRegTemplate(
          this.dbHandle,
          samples[0],
          samples[1],
          samples[2],
          templateBuf,
          templateLenRef
        );
      } else if (numSamples === 2) {
        // Fallback for 2 samples (zero-pad the third)
        const emptyBuf = Buffer.alloc(samples[0].length);
        ret = zktecoLib.ZKFPM_GenRegTemplate(
          this.dbHandle,
          samples[0],
          samples[1],
          emptyBuf,
          templateBuf,
          templateLenRef
        );
      } else {
        throw new Error('Must capture 2 or 3 samples');
      }

      if (ret !== ZKFP_ERR_OK) {
        throw new Error(`ZKFPM_GenRegTemplate failed: ${ret}`);
      }

      const templateLen = templateLenRef.deref();
      const template = templateBuf.slice(0, templateLen);

      console.log(`[ZKTeco] Enrollment successful, template size: ${templateLen}`);

      return {
        success: true,
        template: template,
        samples: numSamples,
        quality: 95,
      };
    } catch (error) {
      console.error('[ZKTeco] Enrollment error:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Verify fingerprint (1:1 match)
   * Returns: { match: boolean, similarity: number (0-100) }
   */
  async verifyFingerprint(storedTemplate) {
    if (!zktecoLib || !this.dbHandle) {
      throw new Error('SDK not initialized');
    }

    try {
      // Capture new fingerprint
      const captureResult = await this.captureFingerprint();
      if (!captureResult.success) {
        throw new Error(`Capture failed: ${captureResult.error}`);
      }

      // Convert stored template if it's base64
      let storedBuf = storedTemplate;
      if (typeof storedTemplate === 'string') {
        storedBuf = Buffer.from(storedTemplate, 'base64');
      }

      // Compare templates
      const similarity = zktecoLib.ZKFPM_DBMatch(
        this.dbHandle,
        storedBuf,
        storedBuf.length,
        captureResult.template,
        captureResult.template.length
      );

      if (similarity < 0) {
        throw new Error(`ZKFPM_DBMatch failed: ${similarity}`);
      }

      // SDK returns similarity score (higher = more similar)
      // Typically: >60 = match, <40 = no match
      const match = similarity >= 60;

      console.log(`[ZKTeco] Verification score: ${similarity}`);

      return {
        success: true,
        match,
        similarity,
      };
    } catch (error) {
      console.error('[ZKTeco] Verification error:', error.message);
      return {
        success: false,
        match: false,
        similarity: 0,
        error: error.message,
      };
    }
  }

  /**
   * Add template to database
   */
  addToDatabase(fingerprintID, template) {
    if (!zktecoLib || !this.dbHandle) {
      throw new Error('SDK not initialized');
    }

    try {
      let templateBuf = template;
      if (typeof template === 'string') {
        templateBuf = Buffer.from(template, 'base64');
      }

      const ret = zktecoLib.ZKFPM_DBAdd(
        this.dbHandle,
        fingerprintID,
        templateBuf,
        templateBuf.length
      );

      if (ret !== ZKFP_ERR_OK) {
        throw new Error(`ZKFPM_DBAdd failed: ${ret}`);
      }

      return true;
    } catch (error) {
      console.error('[ZKTeco] Error adding to database:', error.message);
      return false;
    }
  }

  /**
   * Remove template from database
   */
  removeFromDatabase(fingerprintID) {
    if (!zktecoLib || !this.dbHandle) {
      throw new Error('SDK not initialized');
    }

    try {
      const ret = zktecoLib.ZKFPM_DBDel(this.dbHandle, fingerprintID);
      if (ret !== ZKFP_ERR_OK) {
        throw new Error(`ZKFPM_DBDel failed: ${ret}`);
      }
      return true;
    } catch (error) {
      console.error('[ZKTeco] Error removing from database:', error.message);
      return false;
    }
  }

  /**
   * Convert template to Base64 string for storage
   */
  templateToBase64(template) {
    if (typeof template === 'string') {
      return template;
    }
    return template.toString('base64');
  }

  /**
   * Convert Base64 string to template buffer
   */
  base64ToTemplate(base64String) {
    return Buffer.from(base64String, 'base64');
  }
}

// Create and export singleton
let scannerInstance = null;

function getScanner() {
  if (!scannerInstance) {
    scannerInstance = new ZKTecoFingerprintScanner();
  }
  return scannerInstance;
}

module.exports = {
  getScanner,
  ZKTecoFingerprintScanner,
  ZKFP_ERR_OK,
  ZKFP_ERR_TIMEOUT,
  ZKFP_ERR_INVALID_PARAM,
  ZKFP_ERR_INVALID_HANDLE,
  ZKFP_ERR_OPEN_DEVICE,
  ZKFP_ERR_OPEN_FAILED,
};
