/**
 * Enhanced USB Fingerprint Scanner Service
 * Bridges to ZKTeco SDK via:
 * 1. Native Node.js modules (ffi-napi) - if available
 * 2. Python ctypes bridge - fallback when native modules not available
 */
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
export declare class EnhancedFingerprintScanner {
    private isConnected;
    private QUALITY_THRESHOLD;
    private SIMILARITY_THRESHOLD;
    private MAX_SAMPLES;
    private usePythonBridge;
    constructor();
    /**
     * Call Python bridge for fingerprint operations
     */
    private callPythonBridge;
    /**
     * Initialize SDK and device connection
     */
    private initialize;
    /**
     * Check if scanner is ready
     */
    isReady(): boolean;
    /**
     * Capture single fingerprint from device
     */
    capture(): Promise<CaptureResult>;
    /**
     * Enroll fingerprint (3 samples merged by SDK)
     */
    enroll(employeeId: string): Promise<EnrollmentResult>;
    /**
     * Verify fingerprint for clock in/out
     */
    verify(storedTemplate: string): Promise<VerificationResult>;
    /**
     * Get device status
     */
    getStatus(): {
        connected: boolean;
        ready: boolean;
        mode: string;
    };
    /**
     * Cleanup
     */
    disconnect(): Promise<void>;
}
export declare function getEnhancedScanner(): EnhancedFingerprintScanner;
export default EnhancedFingerprintScanner;
//# sourceMappingURL=enhancedFingerprintScanner.d.ts.map