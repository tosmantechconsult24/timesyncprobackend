/**
 * USB Fingerprint Scanner Service - ENHANCED DELEGATION
 * Routes all operations through enhanced fingerprint scanner
 * Provides backwards compatible interface for existing routes
 */

import { logger } from '../utils/logger';
import { 
  getEnhancedScanner, 
  EnhancedFingerprintScanner,
} from './enhancedFingerprintScanner';

/**
 * Legacy interface - maps to enhanced scanner results
 */
export interface FingerprintScannerResult {
  success: boolean;
  template?: string;
  quality?: number;
  errorCode?: string;
  errorMessage?: string;
  timestamp?: Date;
}

export interface EnrollmentResult {
  success: boolean;
  employeeId?: string;
  template?: string;
  enrollmentCount?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface VerificationResult {
  success: boolean;
  match: boolean;
  similarity?: number;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * USB Fingerprint Scanner - Delegation Wrapper
 * Provides backwards compatible API while using enhanced scanner internally
 */
export class USBFingerprintScanner {
  private enhancedScanner: EnhancedFingerprintScanner;
  private enrollmentData: Map<string, any> = new Map();

  constructor() {
    this.enhancedScanner = getEnhancedScanner();
    logger.info('USB Fingerprint Scanner initialized (enhanced mode)');
  }

  /**
   * Check if scanner is ready
   */
  isReady(): boolean {
    return this.enhancedScanner.isReady();
  }

  /**
   * Capture fingerprint - delegates to enhanced scanner
   */
  async capture(): Promise<FingerprintScannerResult> {
    try {
      const result = await this.enhancedScanner.capture();
      
      // Ensure template is a string
      let template: string | undefined;
      if (result.template) {
        template = typeof result.template === 'string' 
          ? result.template 
          : Buffer.isBuffer(result.template)
            ? result.template.toString('base64')
            : undefined;
      }

      return {
        success: result.success,
        template,
        quality: result.quality,
        errorCode: result.success ? undefined : 'CAPTURE_FAILED',
        errorMessage: result.error,
        timestamp: new Date(),
      };
    } catch (error: any) {
      return {
        success: false,
        errorCode: 'CAPTURE_ERROR',
        errorMessage: error.message || 'An error occurred during fingerprint capture',
      };
    }
  }

  /**
   * Start enrollment - captures multiple samples
   */
  async startEnrollment(employeeId: string): Promise<EnrollmentResult> {
    try {
      logger.info(`Starting fingerprint enrollment for employee: ${employeeId}`);

      const result = await this.enhancedScanner.enroll(employeeId);

      if (!result.success) {
        return {
          success: false,
          employeeId,
          errorCode: 'ENROLLMENT_FAILED',
          errorMessage: result.error,
        };
      }

      // Store enrollment data for reference
      this.enrollmentData.set(employeeId, {
        template: result.template,
        quality: result.quality,
        timestamp: new Date(),
      });

      logger.info(`✓ Enrollment successful for employee: ${employeeId}`);

      return {
        success: true,
        employeeId,
        template: result.template,
        enrollmentCount: result.samples || 3,
      };
    } catch (error: any) {
      logger.error('Error during enrollment:', error);
      return {
        success: false,
        employeeId,
        errorCode: 'ENROLLMENT_ERROR',
        errorMessage: error.message || 'An error occurred during enrollment',
      };
    }
  }

  /**
   * Verify fingerprint against stored template
   */
  async verify(storedTemplate: string): Promise<VerificationResult> {
    try {
      logger.info('Starting fingerprint verification...');

      const result = await this.enhancedScanner.verify(storedTemplate);

      return {
        success: result.success,
        match: result.match,
        similarity: result.similarity,
        errorCode: result.success ? undefined : 'VERIFICATION_FAILED',
        errorMessage: result.error,
      };
    } catch (error: any) {
      logger.error('Error during fingerprint verification:', error);
      return {
        success: false,
        match: false,
        similarity: 0,
        errorCode: 'VERIFICATION_ERROR',
        errorMessage: error.message || 'An error occurred during verification',
      };
    }
  }

  /**
   * Get scanner status
   */
  getStatus(): {
    connected: boolean;
    deviceId: string | null;
    ready: boolean;
  } {
    const status = this.enhancedScanner.getStatus();
    return {
      connected: status.connected,
      deviceId: status.ready ? 'ZKTECO-9500-001' : null,
      ready: status.ready,
    };
  }

  /**
   * Disconnect scanner
   */
  async disconnect(): Promise<void> {
    try {
      await this.enhancedScanner.disconnect();
      this.enrollmentData.clear();
      logger.info('Fingerprint scanner disconnected');
    } catch (error: any) {
      logger.error('Error disconnecting scanner:', error);
    }
  }
}

// Singleton instance
let scannerInstance: USBFingerprintScanner | null = null;

/**
 * Get fingerprint scanner instance
 */
export function getFingerprintScanner(): USBFingerprintScanner {
  if (!scannerInstance) {
    scannerInstance = new USBFingerprintScanner();
  }
  return scannerInstance;
}

export default USBFingerprintScanner;
