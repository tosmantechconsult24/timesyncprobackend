import { randomUUID } from 'crypto';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

/**
 * ZKTeco F22 Fingerprint Terminal Service
 * 
 * Uses TCP/IP Socket communication on port 4370
 * Compatible with: F22, F18, K40, X100-C, and most ZKTeco terminals
 * 
 * Features:
 * - Real-time attendance logs via callback
 * - User management (add/delete/sync)
 * - Remote fingerprint enrollment via USB scanner
 * - Fingerprint template transfer between devices
 * - Device info and status monitoring
 */

// Silence zkteco-js library console output
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

function isSuppressed(args: any[]): boolean {
  const message = String(args[0] || '');
  return message.includes('ZKTeco') || 
         message.includes('zkTeco') || 
         message.includes('socket') ||
         message.includes('port 4370');
}

// Override console methods to silence zkteco output
console.log = function(...args: any[]) {
  if (!isSuppressed(args)) {
    originalLog.apply(console, args);
  }
};

console.error = function(...args: any[]) {
  if (!isSuppressed(args)) {
    originalError.apply(console, args);
  }
};

console.warn = function(...args: any[]) {
  if (!isSuppressed(args)) {
    originalWarn.apply(console, args);
  }
};

console.info = function(...args: any[]) {
  if (!isSuppressed(args)) {
    originalInfo.apply(console, args);
  }
};

interface TerminalConfig {
  id: string;
  name: string;
  ipAddress: string;
  port: number;
  location?: string;
}

export class ZKTecoService {
  private terminals: Map<string, TerminalConfig> = new Map();
  private connections: Map<string, any> = new Map();
  private ZKTeco: any = null;
  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private realTimeConnections: Map<string, boolean> = new Map();
  private initialized: boolean = false;

  /**
   * Initialize the ZKTeco service
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Dynamic import for zkteco-js
      try {
        const zkModule: any = await import('zkteco-js');
        this.ZKTeco = zkModule.default || zkModule.Zkteco || zkModule;
        logger.info('ZKTeco library loaded successfully');
      } catch (importError: any) {
        logger.warn(`ZKTeco library not installed: ${importError.message}`);
        logger.warn('Install with: npm install zkteco-js');
        return;
      }

      // Load terminals from database
      const terminals = await prisma.terminal.findMany({
        where: { isActive: true }
      });

      for (const terminal of terminals) {
        await this.addTerminal(terminal);
      }

      this.initialized = true;
      logger.info(`ZKTeco service initialized with ${terminals.length} terminal(s)`);
    } catch (error: any) {
      logger.error(`Failed to initialize ZKTeco service: ${error.message}`);
    }
  }

  /**
   * Add a terminal to the service
   */
  async addTerminal(terminal: any): Promise<void> {
    const config: TerminalConfig = {
      id: terminal.id,
      name: terminal.name,
      ipAddress: terminal.ipAddress,
      port: terminal.port || 4370,
      location: terminal.location || undefined
    };

    this.terminals.set(config.id, config);
    logger.info(`Terminal added: ${config.name} (${config.ipAddress}:${config.port})`);

    // Test connection and get device info
    try {
      const connected = await this.testConnection(config.id);
      if (connected) {
        const info = await this.getDeviceInfo(config.id);
        await prisma.terminal.update({
          where: { id: config.id },
          data: {
            isOnline: true,
            deviceType: info?.deviceName || 'ZKTeco F22',
            serialNumber: info?.serialNumber || undefined,
            firmwareVersion: info?.version || undefined,
            lastSyncAt: new Date()
          }
        });
        
        // Start real-time log monitoring
        this.startRealTimeLogs(config.id);
      }
    } catch (error: any) {
      logger.warn(`Could not connect to ${config.name}: ${error.message}`);
    }
  }

  /**
   * Remove a terminal from the service
   */
  async removeTerminal(terminalId: string): Promise<void> {
    await this.disconnect(terminalId);
    this.terminals.delete(terminalId);
    logger.info(`Terminal removed: ${terminalId}`);
  }

  /**
   * Create socket connection to terminal
   */
  private async connect(terminalId: string): Promise<any> {
    if (!this.ZKTeco) {
      throw new Error('ZKTeco library not initialized. Install with: npm install zkteco-js');
    }
    
    const config = this.terminals.get(terminalId);
    if (!config) throw new Error('Terminal not found');

    // Check if already connected
    let connection = this.connections.get(terminalId);
    if (connection) {
      return connection;
    }

    try {
      // Create new ZKTeco instance
      // Parameters: IP, port, timeout, inport
      connection = new this.ZKTeco(config.ipAddress, config.port, 5200, 5000);
      await connection.createSocket();
      
      this.connections.set(terminalId, connection);
      logger.info(`Connected to ${config.name}`);
      
      return connection;
    } catch (error: any) {
      logger.error(`Failed to connect to ${config.name}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Disconnect from terminal
   */
  async disconnect(terminalId: string): Promise<void> {
    const connection = this.connections.get(terminalId);
    if (connection) {
      try {
        await connection.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.connections.delete(terminalId);
    }

    // Stop polling
    const interval = this.pollingIntervals.get(terminalId);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(terminalId);
    }
    
    this.realTimeConnections.set(terminalId, false);
  }

  /**
   * Test connection to terminal
   */
  async testConnection(terminalId: string): Promise<boolean> {
    try {
      const connection = await this.connect(terminalId);
      await connection.getInfo();
      
      await prisma.terminal.update({
        where: { id: terminalId },
        data: { isOnline: true, lastSyncAt: new Date() }
      });
      
      await this.disconnect(terminalId);
      return true;
    } catch (error) {
      await prisma.terminal.update({
        where: { id: terminalId },
        data: { isOnline: false }
      }).catch(() => {});
      return false;
    }
  }

  /**
   * Get device information
   */
  async getDeviceInfo(terminalId: string): Promise<any> {
    try {
      const connection = await this.connect(terminalId);
      
      const info = await connection.getInfo().catch(() => ({}));
      const deviceName = await connection.getDeviceName?.().catch(() => 'F22') || 'F22';
      const version = await connection.getDeviceVersion?.().catch(() => null);
      const platform = await connection.getPlatform?.().catch(() => null);

      await this.disconnect(terminalId);

      return {
        ...info,
        deviceName,
        version,
        platform
      };
    } catch (error: any) {
      logger.error(`Failed to get device info: ${error.message}`);
      throw error;
    }
  }

  /**
   * Sync employee to terminal
   */
  async syncEmployeeToTerminal(terminalId: string, employee: any): Promise<void> {
    const config = this.terminals.get(terminalId);
    if (!config) throw new Error('Terminal not found');

    try {
      const connection = await this.connect(terminalId);

      // Generate UID (unique internal ID for terminal)
      const uid = parseInt(employee.employeeId) || Math.floor(Math.random() * 10000);
      const userId = employee.employeeId.toString();
      const name = `${employee.firstName || ''} ${employee.lastName || ''}`.trim().substring(0, 24) || 'User';
      const password = ''; // Can be set if needed
      const role = 0; // 0 = normal user, 14 = admin
      const cardNo = 0; // Card number if using RFID

      // setUser(uid, userid, name, password, role, cardno)
      await connection.setUser(uid, userId, name, password, role, cardNo);
      
      logger.info(`✓ User ${userId} (${name}) synced to ${config.name}`);
      
      await this.disconnect(terminalId);
    } catch (error: any) {
      logger.error(`Failed to sync employee ${employee.employeeId}: ${error.message}`);
      await this.disconnect(terminalId);
      throw error;
    }
  }

  /**
   * Sync all employees to terminal
   */
  async syncAllEmployeesToTerminal(terminalId: string): Promise<{ synced: number; failed: number; total: number }> {
    const employees = await prisma.employee.findMany({
      where: { status: 'active' }
    });

    let synced = 0;
    let failed = 0;

    for (const employee of employees) {
      try {
        await this.syncEmployeeToTerminal(terminalId, employee);
        synced++;
        await new Promise(resolve => setTimeout(resolve, 300)); // Rate limit
      } catch (error) {
        failed++;
        logger.error(`Failed to sync ${employee.employeeId}`);
      }
    }

    return { synced, failed, total: employees.length };
  }

  /**
   * Delete user from terminal
   */
  async deleteUserFromTerminal(terminalId: string, employeeId: string): Promise<void> {
    try {
      const connection = await this.connect(terminalId);
      
      // Find the user's UID first
      const users = await connection.getUsers();
      const user = users.find((u: any) => 
        u.userid === employeeId || 
        u.userId === employeeId ||
        String(u.userid) === employeeId
      );
      
      if (user) {
        await connection.deleteUser(user.uid);
        logger.info(`✓ User ${employeeId} deleted from terminal`);
      }
      
      await this.disconnect(terminalId);
    } catch (error: any) {
      logger.error(`Failed to delete user: ${error.message}`);
      await this.disconnect(terminalId);
      throw error;
    }
  }

  /**
   * Get all users from terminal
   */
  async getUsersFromTerminal(terminalId: string): Promise<any[]> {
    try {
      const connection = await this.connect(terminalId);
      const users = await connection.getUsers();
      await this.disconnect(terminalId);
      return users;
    } catch (error: any) {
      logger.error(`Failed to get users: ${error.message}`);
      await this.disconnect(terminalId);
      throw error;
    }
  }

  /**
   * Get all attendance logs from terminal
   */
  async getAttendanceLogs(terminalId: string): Promise<any[]> {
    try {
      const connection = await this.connect(terminalId);
      const logs = await connection.getAttendances();
      await this.disconnect(terminalId);
      return logs;
    } catch (error: any) {
      logger.error(`Failed to get attendance: ${error.message}`);
      await this.disconnect(terminalId);
      throw error;
    }
  }

  /**
   * Pull attendance logs and process them
   */
  async pullAndProcessAttendance(terminalId: string): Promise<number> {
    const config = this.terminals.get(terminalId);
    if (!config) throw new Error('Terminal not found');

    try {
      const logs = await this.getAttendanceLogs(terminalId);
      let processed = 0;

      for (const log of logs) {
        const wasProcessed = await this.processAttendanceLog(config, log);
        if (wasProcessed) processed++;
      }

      logger.info(`Processed ${processed} attendance logs from ${config.name}`);
      return processed;
    } catch (error: any) {
      logger.error(`Failed to pull attendance: ${error.message}`);
      throw error;
    }
  }

  /**
   * Start real-time log monitoring
   */
  async startRealTimeLogs(terminalId: string): Promise<void> {
    const config = this.terminals.get(terminalId);
    if (!config) return;

    // Prevent duplicate connections
    if (this.realTimeConnections.get(terminalId)) {
      return;
    }

    // Fire and forget - don't await on getRealTimeLogs
    setImmediate(() => {
      this.initializeRealTimeLogs(terminalId).catch(error => {
        logger.error(`Real-time log error for ${config?.name}: ${error.message}`);
      });
    });
  }

  /**
   * Initialize real-time logs (fire and forget)
   */
  private async initializeRealTimeLogs(terminalId: string): Promise<void> {
    const config = this.terminals.get(terminalId);
    if (!config) return;

    try {
      const connection = await this.connect(terminalId);
      this.realTimeConnections.set(terminalId, true);

      logger.info(`Starting real-time monitoring for ${config.name}`);

      // Subscribe to real-time logs - this is a long-running operation
      try {
        await connection.getRealTimeLogs((log: any) => {
          try {
            logger.info(`Real-time log from ${config.name}: User ${log.userId || log.uid}`);
            this.processAttendanceLog(config, log).catch(err => {
              logger.error(`Error processing attendance log: ${err.message}`);
            });
          } catch (error: any) {
            logger.error(`Error in log callback: ${error.message}`);
          }
        });
      } catch (error: any) {
        logger.error(`getRealTimeLogs failed: ${error.message}`);
        // Fall through to polling
      }

    } catch (error: any) {
      logger.error(`Failed to connect for real-time logs to ${config.name}: ${error.message}`);
    }

    // If we get here, real-time failed, fallback to polling
    this.realTimeConnections.set(terminalId, false);
    this.startPolling(terminalId);
  }

  /**
   * Fallback polling for attendance
   */
  private startPolling(terminalId: string): void {
    const config = this.terminals.get(terminalId);
    if (!config) return;

    // Stop existing polling
    const existing = this.pollingIntervals.get(terminalId);
    if (existing) clearInterval(existing);

    // Polling disabled for now - ZKTeco library has connection issues
    logger.info(`Polling disabled for ${config.name} (ZKTeco library issues)`);
    return;

    // Commented out polling code below
    /*
    const pollInterval = parseInt(process.env.POLL_INTERVAL || '30000'); // 30 seconds default

    const interval = setInterval(() => {
      this.pullAndProcessAttendance(terminalId)
        .catch(error => {
          logger.debug(`Polling failed for ${config?.name}: ${error?.message}`);
        });
    }, pollInterval);

    this.pollingIntervals.set(terminalId, interval);
    logger.info(`Started polling for ${config.name} every ${pollInterval}ms`);
    */
  }

  /**
   * Process attendance log entry
   */
  private async processAttendanceLog(config: TerminalConfig, log: any): Promise<boolean> {
    // Extract user ID from log (different field names in different versions)
    const employeeNo = String(log.userId || log.uid || log.user_id || log.odNumber || '');
    
    if (!employeeNo || employeeNo === '0' || employeeNo === 'undefined') {
      return false;
    }

    const timestamp = log.recordTime || log.timestamp || log.time || new Date();

    // Check for duplicate (within 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 300000);
    const existing = await prisma.attendanceLog.findFirst({
      where: {
        Employee: { employeeId: employeeNo },
        timestamp: { gte: fiveMinutesAgo }
      }
    });

    if (existing) {
      return false; // Duplicate
    }

    // Find employee
    const employee = await prisma.employee.findFirst({
      where: { employeeId: employeeNo }
    });

    if (!employee) {
      logger.warn(`Unknown employee ${employeeNo} from ${config.name}`);
      return false;
    }

    // Create attendance log
    await prisma.attendanceLog.create({
      data: {
        id: randomUUID(),
        employeeId: employee.id,
        eventType: 'check_in',
        timestamp: new Date(timestamp),
        terminalId: config.id,
        verifyMethod: this.getVerifyMethod(log.verify || log.verifyType),
        processed: false
      }
    });

    logger.info(`✓ Attendance logged: ${employee.firstName} ${employee.lastName} at ${config.name}`);

    // Process clock in/out
    await this.processClockInOut(employee, timestamp, config);

    // Broadcast to WebSocket
    if ((global as any).io) {
      (global as any).io.to('attendance-updates').emit('attendance:event', {
        type: 'check_in',
        employeeId: employee.employeeId,
        employeeName: `${employee.firstName} ${employee.lastName}`,
        photo: employee.photo,
        timestamp,
        terminal: config.name,
        verifyMethod: 'fingerprint'
      });
    }
    
    return true;
  }

  /**
   * Get verify method name from code
   */
  private getVerifyMethod(code: number | undefined): string {
    const methods: Record<number, string> = {
      0: 'password',
      1: 'fingerprint',
      2: 'card',
      3: 'password+fingerprint',
      4: 'fingerprint+card',
      5: 'password+card',
      6: 'password+fingerprint+card',
      15: 'face'
    };
    return methods[code || 1] || 'fingerprint';
  }

  /**
   * Process clock in/out logic
   */
  private async processClockInOut(employee: any, timestamp: Date | string, config: TerminalConfig): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Check for existing open entry
    const existingEntry = await prisma.timeEntry.findFirst({
      where: {
        employeeId: employee.id,
        clockIn: { gte: today },
        clockOut: null
      }
    });

    if (!existingEntry) {
      // Clock IN
      await prisma.timeEntry.create({
        data: {
          id: randomUUID(),
          employeeId: employee.id,
          clockIn: new Date(timestamp),
          status: 'clocked_in',
          location: config.name,
          terminalId: config.id,
          verifyMethod: 'fingerprint',
          updatedAt: new Date()
        }
      });
      logger.info(`✓ Clock IN: ${employee.firstName} ${employee.lastName}`);
    } else {
      // Check if enough time has passed (4+ hours = clock out)
      const clockInTime = new Date(existingEntry.clockIn);
      const currentTime = new Date(timestamp);
      const hoursSinceClockIn = (currentTime.getTime() - clockInTime.getTime()) / (1000 * 60 * 60);

      if (hoursSinceClockIn >= 4) {
        const totalHours = Math.round(hoursSinceClockIn * 100) / 100;
        const regularHours = Math.min(totalHours, 8);
        const overtimeHours = Math.max(0, totalHours - 8);

        await prisma.timeEntry.update({
          where: { id: existingEntry.id },
          data: {
            clockOut: new Date(timestamp),
            totalHours,
            regularHours,
            overtimeHours,
            status: 'clocked_out'
          }
        });
        logger.info(`✓ Clock OUT: ${employee.firstName} ${employee.lastName} (${totalHours.toFixed(2)} hours)`);
      }
    }
  }

  /**
   * Clear attendance logs from terminal
   */
  async clearAttendanceLogs(terminalId: string): Promise<void> {
    try {
      const connection = await this.connect(terminalId);
      await connection.clearAttendanceLog();
      await this.disconnect(terminalId);
      logger.info(`Attendance logs cleared from terminal ${terminalId}`);
    } catch (error: any) {
      logger.error(`Failed to clear attendance: ${error.message}`);
      await this.disconnect(terminalId);
      throw error;
    }
  }

  /**
   * Get terminal time
   */
  async getTerminalTime(terminalId: string): Promise<Date> {
    try {
      const connection = await this.connect(terminalId);
      const time = await connection.getTime();
      await this.disconnect(terminalId);
      return new Date(time);
    } catch (error: any) {
      logger.error(`Failed to get time: ${error.message}`);
      await this.disconnect(terminalId);
      throw error;
    }
  }

  /**
   * Set terminal time
   */
  async setTerminalTime(terminalId: string, time: Date): Promise<void> {
    try {
      const connection = await this.connect(terminalId);
      await connection.setTime(time);
      await this.disconnect(terminalId);
      logger.info(`Terminal time set to ${time.toISOString()}`);
    } catch (error: any) {
      logger.error(`Failed to set time: ${error.message}`);
      await this.disconnect(terminalId);
      throw error;
    }
  }

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
  async initiateFingerPrintEnrollment(terminalId: string, employeeId: string, fingerIndex: number = 0): Promise<any> {
    const config = this.terminals.get(terminalId);
    if (!config) throw new Error('Terminal not found');

    try {
      // Ensure user exists on terminal first
      const employee = await prisma.employee.findFirst({ where: { employeeId } });
      if (!employee) throw new Error('Employee not found');

      // Sync user to terminal (required before enrollment)
      await this.syncEmployeeToTerminal(terminalId, employee);
      await new Promise(resolve => setTimeout(resolve, 500));

      const connection = await this.connect(terminalId);

      // Get the user's UID on the terminal
      const users = await connection.getUsers();
      const terminalUser = users.find((u: any) => 
        u.userid === employeeId || 
        u.userId === employeeId ||
        String(u.userid) === employeeId
      );
      
      if (!terminalUser) {
        throw new Error('User not found on terminal after sync. Please try again.');
      }

      const uid = terminalUser.uid;

      logger.info(`Starting remote fingerprint enrollment for ${employeeId} (UID: ${uid}) on ${config.name}`);

      // Send CMD_STARTENROLL command
      // This puts the terminal in fingerprint enrollment mode
      // The terminal will display "Place finger" and wait for the employee
      let enrollResult = false;
      
      // Try different enrollment methods based on library version
      if (typeof connection.enrollUser === 'function') {
        enrollResult = await connection.enrollUser(uid, fingerIndex);
      } else if (typeof connection.startEnroll === 'function') {
        enrollResult = await connection.startEnroll(uid, fingerIndex);
      } else {
        // Fallback - return instructions for manual enrollment
        return {
          success: false,
          fallback: true,
          message: 'Remote enrollment not available. Please use manual enrollment.',
          instructions: [
            `1. Employee goes to terminal "${config.name}"`,
            `2. On terminal: Menu → User Mng → Edit User`,
            `3. Find user ${employeeId}`,
            `4. Select "Enroll FP"`,
            `5. Place finger 3 times when prompted`
          ]
        };
      }

      if (enrollResult) {
        // Update employee record
        await prisma.employee.update({
          where: { id: employee.id },
          data: { fingerprintEnrolled: true }
        });

        // Create biometric record
        await prisma.biometricData.create({
          data: {
            id: randomUUID(),
            employeeId: employee.id,
            type: 'fingerprint',
            fingerNo: fingerIndex,
            enrolledAt: new Date()
          }
        }).catch(() => {});

        logger.info(`✓ Fingerprint enrollment initiated for ${employeeId}`);

        return {
          success: true,
          message: 'Fingerprint enrollment started! Terminal is waiting for finger placement.',
          terminal: config.name,
          employeeId,
          uid,
          fingerIndex,
          status: 'enrolling',
          instructions: [
            'The terminal screen now shows "Place Finger"',
            'Employee should place their finger on the sensor',
            'Place the same finger 3 times when prompted',
            'Wait for "Enrollment Successful" message'
          ]
        };
      } else {
        throw new Error('Enrollment command failed');
      }

    } catch (error: any) {
      logger.error(`Fingerprint enrollment failed: ${error.message}`);
      
      // Check if it's a known issue with certain devices
      if (error.message.includes('timeout') || error.message.includes('tcp') || error.message.includes('not a function')) {
        return {
          success: false,
          error: error.message,
          fallback: true,
          message: 'Remote enrollment not supported on this device. Please use manual enrollment.',
          instructions: [
            `1. Employee goes to terminal "${config?.name}"`,
            `2. On terminal: Menu → User Mng → Edit User`,
            `3. Find user ${employeeId}`,
            `4. Select "Enroll FP"`,
            `5. Place finger 3 times when prompted`
          ]
        };
      }
      
      throw error;
    } finally {
      await this.disconnect(terminalId);
    }
  }

  /**
   * Cancel ongoing enrollment
   */
  async cancelEnrollment(terminalId: string): Promise<void> {
    try {
      const connection = await this.connect(terminalId);
      // Try to cancel
      if (typeof connection.cancelCapture === 'function') {
        await connection.cancelCapture();
      }
      await this.disconnect(terminalId);
      logger.info('Enrollment cancelled');
    } catch (error) {
      // Ignore errors on cancel
    }
  }

  /**
   * Get fingerprint templates for a user
   * Used to sync fingerprints between terminals
   */
  async getUserFingerprints(terminalId: string, employeeId: string): Promise<any[]> {
    try {
      const connection = await this.connect(terminalId);
      
      // Get user's UID
      const users = await connection.getUsers();
      const user = users.find((u: any) => 
        u.userid === employeeId || 
        String(u.userid) === employeeId
      );
      
      if (!user) {
        await this.disconnect(terminalId);
        return [];
      }

      // Get all templates for this user (up to 10 fingers)
      const templates: any[] = [];
      
      if (typeof connection.getUserTemplate === 'function') {
        for (let fingerIndex = 0; fingerIndex < 10; fingerIndex++) {
          try {
            const template = await connection.getUserTemplate(user.uid, fingerIndex);
            if (template) {
              templates.push({
                fingerIndex,
                template: template.template || template,
                size: template.size || (typeof template === 'string' ? template.length : 0)
              });
            }
          } catch {
            // No template for this finger
          }
        }
      }

      await this.disconnect(terminalId);
      return templates;
    } catch (error: any) {
      logger.error(`Failed to get fingerprints: ${error.message}`);
      return [];
    }
  }

  /**
   * Upload fingerprint template to terminal
   * Used to sync fingerprints from one terminal to another
   */
  async uploadFingerprint(terminalId: string, employeeId: string, fingerIndex: number, templateData: string): Promise<boolean> {
    try {
      const connection = await this.connect(terminalId);
      
      // Get user's UID
      const users = await connection.getUsers();
      const user = users.find((u: any) => 
        u.userid === employeeId || 
        String(u.userid) === employeeId
      );
      
      if (!user) {
        throw new Error('User not found on terminal');
      }

      // Upload the template if method exists
      let result = false;
      if (typeof connection.setUserTemplate === 'function') {
        result = await connection.setUserTemplate(user.uid, fingerIndex, templateData);
      } else if (typeof connection.saveUserTemplate === 'function') {
        result = await connection.saveUserTemplate(user, [{
          uid: user.uid,
          fid: fingerIndex,
          template: templateData
        }]);
      }

      await this.disconnect(terminalId);
      
      if (result) {
        logger.info(`✓ Fingerprint template uploaded to ${this.terminals.get(terminalId)?.name}`);
        return true;
      }
      return false;
    } catch (error: any) {
      logger.error(`Failed to upload fingerprint: ${error.message}`);
      return false;
    }
  }

  /**
   * Sync fingerprints from one terminal to all others
   */
  async syncFingerprintsToAllTerminals(sourceTerminalId: string, employeeId: string): Promise<{ synced: number; failed: number }> {
    // Get templates from source terminal
    const templates = await this.getUserFingerprints(sourceTerminalId, employeeId);
    
    if (templates.length === 0) {
      logger.warn(`No fingerprint templates found for ${employeeId}`);
      return { synced: 0, failed: 0 };
    }

    let synced = 0;
    let failed = 0;

    // Upload to all other terminals
    for (const [terminalId] of this.terminals) {
      if (terminalId === sourceTerminalId) continue;

      for (const template of templates) {
        const success = await this.uploadFingerprint(
          terminalId,
          employeeId,
          template.fingerIndex,
          template.template
        );
        
        if (success) synced++;
        else failed++;
      }
    }

    logger.info(`Synced ${synced} fingerprint templates for ${employeeId}`);
    return { synced, failed };
  }

  /**
   * Stop all connections
   */
  async stopAll(): Promise<void> {
    for (const [terminalId] of this.terminals) {
      await this.disconnect(terminalId);
    }
    logger.info('All terminal connections stopped');
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down ZKTeco service...');
    await this.stopAll();
    this.initialized = false;
  }

  /**
   * Get status of all terminals
   */
  getTerminalStatuses(): any[] {
    const statuses: any[] = [];
    
    for (const [terminalId, config] of this.terminals) {
      statuses.push({
        id: terminalId,
        name: config.name,
        ipAddress: config.ipAddress,
        port: config.port,
        location: config.location,
        isConnected: this.connections.has(terminalId),
        isRealTimeActive: this.realTimeConnections.get(terminalId) || false,
        isPolling: this.pollingIntervals.has(terminalId)
      });
    }
    
    return statuses;
  }

  /**
   * Get user count on terminal
   */
  async getUserCount(terminalId: string): Promise<number> {
    try {
      const connection = await this.connect(terminalId);
      const info = await connection.getInfo();
      await this.disconnect(terminalId);
      return info?.userCounts || info?.userCount || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// Singleton export (but we use global in index.ts)
export const zktecoService = new ZKTecoService();

