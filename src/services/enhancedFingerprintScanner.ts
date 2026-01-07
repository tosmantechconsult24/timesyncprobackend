/**
 * Enhanced USB Fingerprint Scanner Service
 * Bridges to ZKTeco SDK via:
 * 1. Native Node.js modules (ffi-napi) - if available
 * 2. Python ctypes bridge - fallback when native modules not available
 */

import { logger } from '../utils/logger';
import { spawn } from 'child_process';
import path from 'path';

// Load native SDK wrapper if available
let zkScanner: any = null;
try {
  const { getScanner } = require('./zkTecoSDKNative');
  zkScanner = getScanner();
  logger.info('✓ Using native SDK wrapper (ffi-napi)');
} catch (error: any) {
  logger.warn('Native SDK wrapper not available, will use Python bridge');
  zkScanner = null;
}

export interface FingerprintTemplate {
  data: Buffer | string;
  quality: number;
  timestamp: Date;
}

export interface CaptureResult {
  success: boolean;
  template?: string | Buffer;
  quality?: number;
  error?: string;
}

export interface EnrollmentResult {
  success: boolean;
  template?: string;
  quality?: number;
  samples?: number;
  error?: string;
}

export interface VerificationResult {
  success: boolean;
  match: boolean;
  similarity: number;
  error?: string;
}

export class EnhancedFingerprintScanner {
  private isConnected: boolean = false;
  private QUALITY_THRESHOLD = 50;
  private SIMILARITY_THRESHOLD = 60; // SDK threshold for match
  private MAX_SAMPLES = 3;
  private usePythonBridge: boolean = false;

  constructor() {
    this.initialize();
  }

  /**
   * Call Python bridge for fingerprint operations
   */
  private async callPythonBridge(operation: string, payload: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, 'zkTecoFingerprintBridge.py');
      const args = [operation, JSON.stringify(payload)];

      const process = spawn('python3', [scriptPath, ...args], {
        cwd: __dirname,
        timeout: 30000, // 30 second timeout
      });

      let stdout = '';
      let stderr = '';

      process.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr?.on('data', (data) => {
        stderr += data.toString();
        console.log('[ZKTeco Python]', data.toString());
      });

      process.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Python process exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse Python response: ${stdout}`));
        }
      });

      process.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Initialize SDK and device connection
   */
  private async initialize() {
    try {
      // Try native SDK first
      if (zkScanner) {
        const initialized = await zkScanner.init();
        if (!initialized) {
          logger.error('❌ SDK initialization failed');
          logger.error('CHECK:');
          logger.error('- ZKTeco SDK (v10.0) is installed');
          logger.error('- libzkfp.dll is in System PATH');
          this.isConnected = false;
          return;
        }

        const deviceCount = zkScanner.getDeviceCount();
        if (deviceCount <= 0) {
          logger.error('❌ No USB fingerprint devices found');
          logger.error('CHECK: ZKTeco USB scanner is plugged in (green power light on)');
          this.isConnected = false;
          return;
        }

        const opened = zkScanner.openDevice(0);
        if (!opened) {
          logger.error('❌ Failed to open USB device');
          this.isConnected = false;
          return;
        }

        this.isConnected = true;
        logger.info(`✓ USB Fingerprint Scanner initialized via native SDK (${deviceCount} device(s))`);
        return;
      }

      // Fallback to Python bridge
      logger.info('Attempting to use Python bridge for fingerprint operations...');
      this.usePythonBridge = true;

      try {
        const result = await this.callPythonBridge('init');
        if (result.success) {
          this.isConnected = true;
          logger.info(`✓ USB Fingerprint Scanner initialized via Python bridge (${result.device_count} device(s))`);
          return;
        }

        logger.error('❌ Python bridge initialization failed:', result.error);
        logger.error('CHECK:');
        logger.error('- Python 3 is installed: python --version');
        logger.error('- ZKTeco USB scanner is plugged in');
        logger.error('- libzkfp.dll is in C:\\Windows\\System32\\');
        this.isConnected = false;
      } catch (error: any) {
        logger.error('❌ Could not initialize fingerprint scanner');
        logger.error('Neither native SDK nor Python bridge available');
        logger.error('SETUP OPTIONS:');
        logger.error('Option 1 (Recommended): Install Visual Studio Build Tools with C++');
        logger.error('  Then run: npm install ffi-napi ref-napi');
        logger.error('Option 2: Ensure Python 3 is installed');
        logger.error('  Verify with: python --version');
        logger.error('Option 3: Copy libzkfp.dll to C:\\Windows\\System32\\');
        logger.error('See ZKTECO_SETUP_INSTRUCTIONS.md for details');
        this.isConnected = false;
      }
    } catch (error: any) {
      logger.error('❌ Unexpected initialization error:', error.message);
      this.isConnected = false;
    }
  }

  /**
   * Check if scanner is ready
   */
  isReady(): boolean {
    return this.isConnected && (zkScanner !== null || this.usePythonBridge);
  }

  /**
   * Capture single fingerprint from device
   */
  async capture(): Promise<CaptureResult> {
    if (!this.isReady()) {
      return {
        success: false,
        error: 'Scanner not connected. Please check USB connection.',
      };
    }

    try {
      logger.info('Capturing fingerprint...');

      let result;
      if (this.usePythonBridge) {
        result = await this.callPythonBridge('capture');
      } else {
        result = await zkScanner.captureFingerprint();
      }

      if (!result.success || !result.template) {
        return {
          success: false,
          error: result.error || 'Failed to capture fingerprint from device',
        };
      }

      const quality = result.quality || 95;
      logger.info(`✓ Fingerprint captured (quality: ${quality}%)`);

      return {
        success: true,
        template: result.template,
        quality,
      };
    } catch (error: any) {
      logger.error('Capture error:', error.message);
      return {
        success: false,
        error: error.message || 'Capture failed',
      };
    }
  }

  /**
   * Enroll fingerprint (3 samples merged by SDK)
   */
  async enroll(employeeId: string): Promise<EnrollmentResult> {
    if (!this.isReady()) {
      return {
        success: false,
        error: 'Scanner not connected',
      };
    }

    try {
      logger.info(`Starting enrollment for employee: ${employeeId}`);

      let result;
      if (this.usePythonBridge) {
        result = await this.callPythonBridge('enroll');
      } else {
        result = await zkScanner.enrollFingerprint(this.MAX_SAMPLES);
      }

      if (!result.success) {
        return {
          success: false,
          samples: 0,
          error: result.error || 'Enrollment failed',
        };
      }

      logger.info(`✓ Enrollment completed (${this.MAX_SAMPLES} samples merged)`);

      return {
        success: true,
        template: result.template,
        quality: result.quality || 95,
        samples: this.MAX_SAMPLES,
      };
    } catch (error: any) {
      logger.error('Enrollment error:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Verify fingerprint for clock in/out
   */
  async verify(storedTemplate: string): Promise<VerificationResult> {
    if (!this.isReady()) {
      return {
        success: false,
        match: false,
        similarity: 0,
        error: 'Scanner not connected',
      };
    }

    try {
      logger.info('Verifying fingerprint...');

      let result;
      if (this.usePythonBridge) {
        result = await this.callPythonBridge('verify', { template: storedTemplate });
      } else {
        result = await zkScanner.verifyFingerprint(storedTemplate);
      }

      if (!result.success) {
        return {
          success: false,
          match: false,
          similarity: 0,
          error: result.error || 'Verification failed',
        };
      }

      const match = result.match;
      const similarity = result.similarity || 0;

      logger.info(
        `✓ Verification complete - Match: ${match}, Similarity: ${similarity}`
      );

      return {
        success: true,
        match,
        similarity,
      };
    } catch (error: any) {
      logger.error('Verification error:', error.message);
      return {
        success: false,
        match: false,
        similarity: 0,
        error: error.message,
      };
    }
  }

  /**
   * Get device status
   */
  getStatus(): {
    connected: boolean;
    ready: boolean;
    mode: string;
  } {
    return {
      connected: this.isConnected,
      ready: this.isReady(),
      mode: this.isReady() ? 'Native SDK' : 'Unavailable',
    };
  }

  /**
   * Cleanup
   */
  async disconnect() {
    try {
      if (zkScanner) {
        zkScanner.closeDevice();
        zkScanner.terminate();
      }
      this.isConnected = false;
      logger.info('Scanner disconnected');
    } catch (error: any) {
      logger.error('Disconnect error:', error.message);
    }
  }
}

// Singleton instance
let scannerInstance: EnhancedFingerprintScanner | null = null;

export function getEnhancedScanner(): EnhancedFingerprintScanner {
  if (!scannerInstance) {
    scannerInstance = new EnhancedFingerprintScanner();
  }
  return scannerInstance;
}

export default EnhancedFingerprintScanner;
