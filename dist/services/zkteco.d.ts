export declare class ZKTecoService {
    private terminals;
    private connections;
    private ZKTeco;
    private pollingIntervals;
    private realTimeConnections;
    private initialized;
    /**
     * Initialize the ZKTeco service
     */
    initialize(): Promise<void>;
    /**
     * Add a terminal to the service
     */
    addTerminal(terminal: any): Promise<void>;
    /**
     * Remove a terminal from the service
     */
    removeTerminal(terminalId: string): Promise<void>;
    /**
     * Create socket connection to terminal
     */
    private connect;
    /**
     * Disconnect from terminal
     */
    disconnect(terminalId: string): Promise<void>;
    /**
     * Test connection to terminal
     */
    testConnection(terminalId: string): Promise<boolean>;
    /**
     * Get device information
     */
    getDeviceInfo(terminalId: string): Promise<any>;
    /**
     * Sync employee to terminal
     */
    syncEmployeeToTerminal(terminalId: string, employee: any): Promise<void>;
    /**
     * Sync all employees to terminal
     */
    syncAllEmployeesToTerminal(terminalId: string): Promise<{
        synced: number;
        failed: number;
        total: number;
    }>;
    /**
     * Delete user from terminal
     */
    deleteUserFromTerminal(terminalId: string, employeeId: string): Promise<void>;
    /**
     * Get all users from terminal
     */
    getUsersFromTerminal(terminalId: string): Promise<any[]>;
    /**
     * Get all attendance logs from terminal
     */
    getAttendanceLogs(terminalId: string): Promise<any[]>;
    /**
     * Pull attendance logs and process them
     */
    pullAndProcessAttendance(terminalId: string): Promise<number>;
    /**
     * Start real-time log monitoring
     */
    startRealTimeLogs(terminalId: string): Promise<void>;
    /**
     * Initialize real-time logs (fire and forget)
     */
    private initializeRealTimeLogs;
    /**
     * Fallback polling for attendance
     */
    private startPolling;
    /**
     * Process attendance log entry
     */
    private processAttendanceLog;
    /**
     * Get verify method name from code
     */
    private getVerifyMethod;
    /**
     * Process clock in/out logic
     */
    private processClockInOut;
    /**
     * Clear attendance logs from terminal
     */
    clearAttendanceLogs(terminalId: string): Promise<void>;
    /**
     * Get terminal time
     */
    getTerminalTime(terminalId: string): Promise<Date>;
    /**
     * Set terminal time
     */
    setTerminalTime(terminalId: string, time: Date): Promise<void>;
    /**
     * Initiate REMOTE fingerprint enrollment from web app
     *
     * This sends CMD_STARTENROLL (command 61) to the terminal which:
     * 1. Puts the terminal in enrollment mode
     * 2. Displays "Place finger" on the terminal screen
     * 3. Employee places finger 3 times
     * 4. Template is saved on the device
     *
     * The web app can monitor enrollment progress via real-time events
     */
    initiateFingerPrintEnrollment(terminalId: string, employeeId: string, fingerIndex?: number): Promise<any>;
    /**
     * Cancel ongoing enrollment
     */
    cancelEnrollment(terminalId: string): Promise<void>;
    /**
     * Get fingerprint templates for a user
     * Used to sync fingerprints between terminals
     */
    getUserFingerprints(terminalId: string, employeeId: string): Promise<any[]>;
    /**
     * Upload fingerprint template to terminal
     * Used to sync fingerprints from one terminal to another
     */
    uploadFingerprint(terminalId: string, employeeId: string, fingerIndex: number, templateData: string): Promise<boolean>;
    /**
     * Sync fingerprints from one terminal to all others
     */
    syncFingerprintsToAllTerminals(sourceTerminalId: string, employeeId: string): Promise<{
        synced: number;
        failed: number;
    }>;
    /**
     * Stop all connections
     */
    stopAll(): Promise<void>;
    /**
     * Shutdown the service
     */
    shutdown(): Promise<void>;
    /**
     * Get status of all terminals
     */
    getTerminalStatuses(): any[];
    /**
     * Get user count on terminal
     */
    getUserCount(terminalId: string): Promise<number>;
    /**
     * Check if service is initialized
     */
    isInitialized(): boolean;
}
export declare const zktecoService: ZKTecoService;
//# sourceMappingURL=zkteco.d.ts.map