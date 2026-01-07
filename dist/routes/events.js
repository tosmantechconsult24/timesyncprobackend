"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = require("crypto");
const prisma_1 = require("../utils/prisma");
const logger_1 = require("../utils/logger");
const router = (0, express_1.Router)();
/**
 * ZKTeco ADMS Push Protocol Handler
 *
 * This handles push events from ZKTeco devices configured in ADMS mode.
 * The device sends HTTP requests to this server when events occur.
 *
 * Endpoints used by ZKTeco ADMS:
 * - GET  /iclock/cdata - Device initialization/options
 * - POST /iclock/cdata - Attendance data upload
 * - GET  /iclock/getrequest - Device polls for commands
 * - POST /iclock/devicecmd - Device reports command results
 */
/**
 * Handle device initialization request
 * GET /iclock/cdata?SN=xxx&options=all
 */
router.get('/cdata', async (req, res) => {
    const serialNumber = req.query.SN;
    const options = req.query.options;
    logger_1.logger.info(`ZKTeco device init: SN=${serialNumber}, options=${options}`);
    // Find or create terminal by serial number
    if (serialNumber) {
        // First try to find existing terminal
        const existingTerminal = await prisma_1.prisma.terminal.findFirst({
            where: { serialNumber }
        });
        if (existingTerminal) {
            await prisma_1.prisma.terminal.update({
                where: { id: existingTerminal.id },
                data: {
                    isOnline: true,
                    lastSyncAt: new Date()
                }
            });
        }
        else {
            // Create new terminal
            await prisma_1.prisma.terminal.create({
                data: {
                    id: (0, crypto_1.randomUUID)(),
                    name: `ZKTeco-${serialNumber}`,
                    serialNumber,
                    ipAddress: req.ip || '0.0.0.0',
                    port: 4370,
                    password: '', // Required field in your schema
                    deviceType: 'ZKTeco',
                    isOnline: true,
                    isActive: true,
                    updatedAt: new Date()
                }
            }).catch(() => { });
        }
    }
    // Respond with device options
    // Format: GET OPTION FROM: [tablename]
    res.type('text/plain');
    res.send(`GET OPTION FROM: ATTLOG
ATTLOGStamp=None
OPERLOGStamp=None
ATTPHOTOStamp=None
ErrorDelay=30
Delay=30
TransTimes=00:00;14:00
TransInterval=1
TransFlag=TransData AttLog OpLog AttPhoto
Realtime=1
TimeZone=0
Encrypt=None`);
});
/**
 * Handle attendance data upload
 * POST /iclock/cdata?SN=xxx&table=ATTLOG
 */
router.post('/cdata', async (req, res) => {
    const serialNumber = req.query.SN;
    const table = req.query.table;
    const stamp = req.query.Stamp;
    logger_1.logger.info(`ZKTeco data upload: SN=${serialNumber}, table=${table}`);
    // Get raw body
    let bodyData = '';
    if (typeof req.body === 'string') {
        bodyData = req.body;
    }
    else if (Buffer.isBuffer(req.body)) {
        bodyData = req.body.toString();
    }
    else if (req.body) {
        bodyData = JSON.stringify(req.body);
    }
    logger_1.logger.info(`Data: ${bodyData.substring(0, 500)}`);
    // Update terminal online status
    if (serialNumber) {
        await prisma_1.prisma.terminal.updateMany({
            where: { serialNumber },
            data: { isOnline: true, lastSyncAt: new Date() }
        }).catch(() => { });
    }
    // Parse attendance logs (ATTLOG table)
    if (table === 'ATTLOG' && bodyData) {
        const lines = bodyData.split('\n').filter(line => line.trim());
        let processed = 0;
        for (const line of lines) {
            try {
                // Format: PIN\tTime\tStatus\tVerify\tWorkCode\tReserved1\tReserved2
                // Example: 1\t2024-12-04 08:30:00\t0\t1\t0\t0\t0
                const parts = line.split('\t');
                if (parts.length >= 2) {
                    const employeeId = parts[0].trim();
                    const timestamp = parts[1].trim();
                    const status = parseInt(parts[2] || '0'); // 0=Check-in, 1=Check-out
                    const verifyMode = parseInt(parts[3] || '1'); // 1=FP, 2=Card, etc.
                    if (employeeId && employeeId !== '0') {
                        await processAttendanceRecord({
                            employeeId,
                            timestamp,
                            status,
                            verifyMode,
                            serialNumber
                        });
                        processed++;
                    }
                }
            }
            catch (e) {
                logger_1.logger.error(`Failed to parse line: ${line} - ${e.message}`);
            }
        }
        logger_1.logger.info(`Processed ${processed} attendance records from ${serialNumber}`);
    }
    // Parse user data (USER table)
    if (table === 'OPERLOG' && bodyData) {
        logger_1.logger.info(`Operation log from ${serialNumber}: ${bodyData.substring(0, 200)}`);
    }
    // Respond with OK and count
    const lineCount = bodyData.split('\n').filter(l => l.trim()).length;
    res.type('text/plain');
    res.send(`OK: ${lineCount}`);
});
/**
 * Handle device polling for commands
 * GET /iclock/getrequest?SN=xxx
 */
router.get('/getrequest', async (req, res) => {
    const serialNumber = req.query.SN;
    // Update terminal online status
    if (serialNumber) {
        await prisma_1.prisma.terminal.updateMany({
            where: { serialNumber },
            data: { isOnline: true, lastSyncAt: new Date() }
        }).catch(() => { });
    }
    // Check for pending commands for this device
    // Commands format: C:ID:COMMAND DATA
    // Example: C:1:DATA USER PIN=123\tName=John
    // For now, just respond OK (no pending commands)
    res.type('text/plain');
    res.send('OK');
});
/**
 * Handle device command results
 * POST /iclock/devicecmd?SN=xxx
 */
router.post('/devicecmd', async (req, res) => {
    const serialNumber = req.query.SN;
    logger_1.logger.info(`Device command result from ${serialNumber}: ${JSON.stringify(req.body)}`);
    res.type('text/plain');
    res.send('OK');
});
/**
 * Catch-all for other ZKTeco endpoints
 */
router.all('*', (req, res) => {
    logger_1.logger.info(`ZKTeco request: ${req.method} ${req.path} - Query: ${JSON.stringify(req.query)}`);
    res.type('text/plain');
    res.send('OK');
});
/**
 * Process attendance record
 */
async function processAttendanceRecord(data) {
    const { employeeId, timestamp, status, verifyMode, serialNumber } = data;
    // Check for duplicate (within 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 300000);
    const existing = await prisma_1.prisma.attendanceLog.findFirst({
        where: {
            Employee: { employeeId },
            timestamp: { gte: fiveMinutesAgo }
        }
    });
    if (existing) {
        logger_1.logger.info(`Duplicate attendance ignored for ${employeeId}`);
        return;
    }
    // Find employee
    const employee = await prisma_1.prisma.employee.findFirst({
        where: { employeeId }
    });
    if (!employee) {
        logger_1.logger.warn(`Unknown employee ${employeeId}`);
        return;
    }
    // Find terminal
    const terminal = serialNumber
        ? await prisma_1.prisma.terminal.findFirst({ where: { serialNumber } })
        : null;
    // Create attendance log
    const eventType = status === 1 ? 'check_out' : 'check_in';
    await prisma_1.prisma.attendanceLog.create({
        data: {
            id: (0, crypto_1.randomUUID)(),
            employeeId: employee.id,
            eventType,
            timestamp: new Date(timestamp),
            terminalId: terminal?.id,
            verifyMethod: getVerifyMethod(verifyMode),
            processed: false
        }
    });
    logger_1.logger.info(`✓ Attendance: ${employee.firstName} ${employee.lastName} - ${eventType}`);
    // Process clock in/out
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const existingEntry = await prisma_1.prisma.timeEntry.findFirst({
        where: {
            employeeId: employee.id,
            clockIn: { gte: today },
            clockOut: null
        }
    });
    if (eventType === 'check_in' && !existingEntry) {
        // Clock IN
        await prisma_1.prisma.timeEntry.create({
            data: {
                id: (0, crypto_1.randomUUID)(),
                employeeId: employee.id,
                clockIn: new Date(timestamp),
                status: 'clocked_in',
                location: terminal?.name || 'Terminal',
                terminalId: terminal?.id,
                verifyMethod: getVerifyMethod(verifyMode),
                updatedAt: new Date()
            }
        });
        logger_1.logger.info(`✓ Clock IN: ${employee.firstName} ${employee.lastName}`);
    }
    else if (eventType === 'check_out' && existingEntry) {
        // Clock OUT
        const clockInTime = new Date(existingEntry.clockIn);
        const clockOutTime = new Date(timestamp);
        const totalHours = (clockOutTime.getTime() - clockInTime.getTime()) / (1000 * 60 * 60);
        const regularHours = Math.min(totalHours, 8);
        const overtimeHours = Math.max(0, totalHours - 8);
        await prisma_1.prisma.timeEntry.update({
            where: { id: existingEntry.id },
            data: {
                clockOut: clockOutTime,
                totalHours: Math.round(totalHours * 100) / 100,
                regularHours: Math.round(regularHours * 100) / 100,
                overtimeHours: Math.round(overtimeHours * 100) / 100,
                status: 'clocked_out'
            }
        });
        logger_1.logger.info(`✓ Clock OUT: ${employee.firstName} ${employee.lastName} (${totalHours.toFixed(2)} hours)`);
    }
    else if (!existingEntry) {
        // First scan of the day - treat as clock in regardless of status
        await prisma_1.prisma.timeEntry.create({
            data: {
                id: (0, crypto_1.randomUUID)(),
                employeeId: employee.id,
                clockIn: new Date(timestamp),
                status: 'clocked_in',
                location: terminal?.name || 'Terminal',
                terminalId: terminal?.id,
                verifyMethod: getVerifyMethod(verifyMode),
                updatedAt: new Date()
            }
        });
        logger_1.logger.info(`✓ Clock IN (auto): ${employee.firstName} ${employee.lastName}`);
    }
    // Broadcast to WebSocket
    if (global.io) {
        global.io.to('attendance-updates').emit('attendance:event', {
            type: eventType,
            employeeId: employee.employeeId,
            employeeName: `${employee.firstName} ${employee.lastName}`,
            photo: employee.photo,
            timestamp,
            terminal: terminal?.name || 'Terminal',
            verifyMethod: getVerifyMethod(verifyMode)
        });
    }
}
/**
 * Get verify method name
 */
function getVerifyMethod(mode) {
    const methods = {
        0: 'password',
        1: 'fingerprint',
        2: 'card',
        3: 'password+fingerprint',
        4: 'fingerprint+card',
        5: 'password+card',
        6: 'password+fingerprint+card',
        15: 'face'
    };
    return methods[mode] || 'unknown';
}
exports.default = router;
//# sourceMappingURL=events.js.map