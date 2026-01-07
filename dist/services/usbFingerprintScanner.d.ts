/**
 * USB Fingerprint Scanner Service - ENHANCED DELEGATION
 * Routes all operations through enhanced fingerprint scanner
 * Provides backwards compatible interface for existing routes
 */
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
export declare class USBFingerprintScanner {
    private enhancedScanner;
    private enrollmentData;
    constructor();
    /**
     * Check if scanner is ready
     */
    isReady(): boolean;
    /**
     * Capture fingerprint - delegates to enhanced scanner
     */
    capture(): Promise<FingerprintScannerResult>;
    /**
     * Start enrollment - captures multiple samples
     */
    startEnrollment(employeeId: string): Promise<EnrollmentResult>;
    /**
     * Verify fingerprint against stored template
     */
    verify(storedTemplate: string): Promise<VerificationResult>;
    /**
     * Get scanner status
     */
    getStatus(): {
        connected: boolean;
        deviceId: string | null;
        ready: boolean;
    };
    /**
     * Disconnect scanner
     */
    disconnect(): Promise<void>;
}
/**
 * Get fingerprint scanner instance
 */
export declare function getFingerprintScanner(): USBFingerprintScanner;
export default USBFingerprintScanner;
//# sourceMappingURL=usbFingerprintScanner.d.ts.map