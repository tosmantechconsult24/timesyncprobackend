"use strict";
/**
 * USB Fingerprint Scanner Service - ENHANCED DELEGATION
 * Routes all operations through enhanced fingerprint scanner
 * Provides backwards compatible interface for existing routes
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.USBFingerprintScanner = void 0;
exports.getFingerprintScanner = getFingerprintScanner;
const logger_1 = require("../utils/logger");
const enhancedFingerprintScanner_1 = require("./enhancedFingerprintScanner");
/**
 * USB Fingerprint Scanner - Delegation Wrapper
 * Provides backwards compatible API while using enhanced scanner internally
 */
class USBFingerprintScanner {
    enhancedScanner;
    enrollmentData = new Map();
    constructor() {
        this.enhancedScanner = (0, enhancedFingerprintScanner_1.getEnhancedScanner)();
        logger_1.logger.info('USB Fingerprint Scanner initialized (enhanced mode)');
    }
    /**
     * Check if scanner is ready
     */
    isReady() {
        return this.enhancedScanner.isReady();
    }
    /**
     * Capture fingerprint - delegates to enhanced scanner
     */
    async capture() {
        try {
            const result = await this.enhancedScanner.capture();
            // Ensure template is a string
            let template;
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
        }
        catch (error) {
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
    async startEnrollment(employeeId) {
        try {
            logger_1.logger.info(`Starting fingerprint enrollment for employee: ${employeeId}`);
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
            logger_1.logger.info(`✓ Enrollment successful for employee: ${employeeId}`);
            return {
                success: true,
                employeeId,
                template: result.template,
                enrollmentCount: result.samples || 3,
            };
        }
        catch (error) {
            logger_1.logger.error('Error during enrollment:', error);
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
    async verify(storedTemplate) {
        try {
            logger_1.logger.info('Starting fingerprint verification...');
            const result = await this.enhancedScanner.verify(storedTemplate);
            return {
                success: result.success,
                match: result.match,
                similarity: result.similarity,
                errorCode: result.success ? undefined : 'VERIFICATION_FAILED',
                errorMessage: result.error,
            };
        }
        catch (error) {
            logger_1.logger.error('Error during fingerprint verification:', error);
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
    getStatus() {
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
    async disconnect() {
        try {
            await this.enhancedScanner.disconnect();
            this.enrollmentData.clear();
            logger_1.logger.info('Fingerprint scanner disconnected');
        }
        catch (error) {
            logger_1.logger.error('Error disconnecting scanner:', error);
        }
    }
}
exports.USBFingerprintScanner = USBFingerprintScanner;
// Singleton instance
let scannerInstance = null;
/**
 * Get fingerprint scanner instance
 */
function getFingerprintScanner() {
    if (!scannerInstance) {
        scannerInstance = new USBFingerprintScanner();
    }
    return scannerInstance;
}
exports.default = USBFingerprintScanner;
//# sourceMappingURL=usbFingerprintScanner.js.map