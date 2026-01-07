"use strict";
// ============================================
// index.ts - Main Server Entry Point
// With proper Kiosk route configuration
// ============================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.io = exports.app = exports.broadcastAttendanceEvent = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const prisma_1 = require("./utils/prisma");
const logger_1 = require("./utils/logger");
const errorHandler_1 = require("./middleware/errorHandler");
const auth_1 = require("./middleware/auth");
// Routes
const auth_2 = __importDefault(require("./routes/auth"));
const employees_1 = __importDefault(require("./routes/employees"));
const departments_1 = __importDefault(require("./routes/departments"));
const shifts_1 = __importDefault(require("./routes/shifts"));
const timeEntries_1 = __importDefault(require("./routes/timeEntries"));
const attendance_1 = __importDefault(require("./routes/attendance"));
const leaves_1 = __importDefault(require("./routes/leaves"));
const reports_1 = __importDefault(require("./routes/reports"));
const settings_1 = __importDefault(require("./routes/settings"));
const terminals_1 = __importDefault(require("./routes/terminals"));
const dashboard_1 = __importDefault(require("./routes/dashboard"));
const users_1 = __importDefault(require("./routes/users"));
const payroll_1 = __importDefault(require("./routes/payroll"));
// Services
const seedData_1 = require("./utils/seedData");
const crypto_1 = require("crypto");
// Hikvision Service stub - can be implemented later
class HikvisionService {
    async initialize() {
        // Initialize Hikvision service
    }
    stopPolling() {
        // Stop polling
    }
}
dotenv_1.default.config();
const app = (0, express_1.default)();
exports.app = app;
const httpServer = (0, http_1.createServer)(app);
// Log raw TCP connections to help debug sudden crashes on request
httpServer.on('connection', (socket) => {
    try {
        const remote = socket.remoteAddress + ':' + socket.remotePort;
        logger_1.logger.info(`Raw connection from ${remote}`);
    }
    catch (e) {
        logger_1.logger.error('Error logging raw connection', e);
    }
});
// Socket.IO for real-time updates
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173', 'http://localhost:3000'],
        methods: ['GET', 'POST'],
        credentials: true
    }
});
exports.io = io;
global.io = io;
global.hikvisionService = new HikvisionService();
// Middleware
app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use((0, cors_1.default)({
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173', 'http://localhost:3000'],
    credentials: true
}));
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Basic request logger for debugging crashing requests
app.use((req, res, next) => {
    logger_1.logger.info(`Incoming request: ${req.method} ${req.url}`);
    next();
});
// Catch global errors so we can log stack traces instead of crashing silently
process.on('uncaughtException', (err) => {
    logger_1.logger.error('Uncaught Exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    logger_1.logger.error('Unhandled Rejection:', reason && (reason.stack || reason));
});
// Rate limiting
const limiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000 // limit each IP to 1000 requests per windowMs
});
app.use('/api', limiter);
// Static files for uploads
app.use('/uploads', express_1.default.static(path_1.default.join(__dirname, '../uploads')));
// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// ============================================
// KIOSK ROUTES (No Authentication Required)
// These endpoints use fingerprint verification instead of JWT
// ============================================
// Employee lookup for kiosk
app.get('/api/employees/lookup/:employeeId', async (req, res, next) => {
    try {
        const searchId = req.params.employeeId;
        const employee = await prisma_1.prisma.employee.findFirst({
            where: {
                OR: [
                    { id: searchId },
                    { employeeId: searchId },
                ],
            },
            include: {
                department: { select: { id: true, name: true } },
                shift: { select: { id: true, name: true, startTime: true, endTime: true } },
            },
        });
        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }
        // Check if fingerprint enrolled
        const fingerprint = await prisma_1.prisma.biometricData.findFirst({
            where: {
                employeeId: employee.id,
                type: 'FINGERPRINT'
            },
        });
        // Get today's attendance
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayAttendance = await prisma_1.prisma.attendanceLog.findMany({
            where: {
                employeeId: employee.id,
                timestamp: { gte: today },
            },
            orderBy: { timestamp: 'desc' },
        });
        res.json({
            id: employee.id,
            employeeId: employee.employeeId,
            firstName: employee.firstName,
            lastName: employee.lastName,
            email: employee.email,
            phone: employee.phone,
            photo: employee.photo,
            status: employee.status,
            department: employee.department,
            shift: employee.shift,
            fingerprintEnrolled: !!fingerprint?.data,
            todayAttendance,
        });
    }
    catch (error) {
        logger_1.logger.error('Employee lookup error:', error);
        res.status(500).json({ error: 'Failed to lookup employee' });
    }
});
// Get fingerprint template for kiosk verification
app.get('/api/employees/fingerprint-template/:employeeId', async (req, res, next) => {
    try {
        const searchId = req.params.employeeId;
        const employee = await prisma_1.prisma.employee.findFirst({
            where: {
                OR: [
                    { id: searchId },
                    { employeeId: searchId },
                ],
            },
        });
        if (!employee) {
            return res.status(404).json({ error: 'Employee not found', enrolled: false });
        }
        const biometric = await prisma_1.prisma.biometricData.findFirst({
            where: {
                employeeId: employee.id,
                type: 'FINGERPRINT',
            },
            orderBy: { enrolledAt: 'desc' },
        });
        if (!biometric || !biometric.data) {
            return res.status(404).json({
                error: 'No fingerprint registered. Please enroll fingerprint first.',
                enrolled: false
            });
        }
        res.json({
            template: biometric.data,
            enrolled: true,
            fingerNo: biometric.fingerNo || 0,
            employeeId: employee.employeeId
        });
    }
    catch (error) {
        logger_1.logger.error('Get fingerprint template error:', error);
        res.status(500).json({ error: 'Failed to get fingerprint template' });
    }
});
// Enroll fingerprint from USB scanner (for kiosk use)
app.post('/api/employees/fingerprint-enroll/:employeeId', async (req, res, next) => {
    try {
        const { template, fingerNo = 0, quality = 100 } = req.body;
        const searchId = req.params.employeeId;
        if (!template) {
            return res.status(400).json({ error: 'Fingerprint template is required' });
        }
        const employee = await prisma_1.prisma.employee.findFirst({
            where: {
                OR: [
                    { id: searchId },
                    { employeeId: searchId },
                ],
            },
        });
        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }
        // Check for existing fingerprint
        const existingBiometric = await prisma_1.prisma.biometricData.findFirst({
            where: {
                employeeId: employee.id,
                type: 'FINGERPRINT',
                fingerNo: fingerNo,
            },
        });
        let biometric;
        if (existingBiometric) {
            biometric = await prisma_1.prisma.biometricData.update({
                where: { id: existingBiometric.id },
                data: {
                    data: template,
                    enrolledAt: new Date(),
                },
            });
            logger_1.logger.info(`Fingerprint updated for employee ${employee.employeeId}`);
        }
        else {
            biometric = await prisma_1.prisma.biometricData.create({
                data: {
                    id: (0, crypto_1.randomUUID)(),
                    employeeId: employee.id,
                    type: 'FINGERPRINT',
                    data: template,
                    fingerNo,
                    enrolledAt: new Date(),
                },
            });
            logger_1.logger.info(`Fingerprint enrolled for employee ${employee.employeeId}`);
        }
        // Update employee fingerprint status
        await prisma_1.prisma.employee.update({
            where: { id: employee.id },
            data: { fingerprintEnrolled: true },
        });
        res.json({
            success: true,
            message: 'Fingerprint enrolled successfully',
            biometricId: biometric.id,
            employeeId: employee.employeeId,
        });
    }
    catch (error) {
        logger_1.logger.error('Fingerprint enrollment error:', error);
        res.status(500).json({ error: 'Failed to enroll fingerprint: ' + error.message });
    }
});
// Record attendance from kiosk (fingerprint is the auth)
app.post('/api/attendance/record', async (req, res, next) => {
    try {
        logger_1.logger.info('Entered /api/attendance/record handler');
        logger_1.logger.info(`Payload: ${JSON.stringify(req.body).slice(0, 200)}`);
        const { employeeId, type, timestamp, verificationMethod = 'FINGERPRINT', location = 'Kiosk', terminalId, } = req.body;
        if (!employeeId || !type) {
            return res.status(400).json({ error: 'employeeId and type are required' });
        }
        const normalizedType = type.toUpperCase();
        if (!['CLOCK_IN', 'CLOCK_OUT'].includes(normalizedType)) {
            return res.status(400).json({ error: 'Invalid attendance type. Use clock_in or clock_out' });
        }
        const employee = await prisma_1.prisma.employee.findFirst({
            where: {
                OR: [
                    { id: employeeId },
                    { employeeId: employeeId },
                ],
            },
            include: {
                department: { select: { name: true } },
                shift: { select: { name: true, startTime: true, endTime: true } },
            },
        });
        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }
        if (employee.status !== 'active') {
            return res.status(403).json({
                error: `Cannot clock ${normalizedType === 'CLOCK_IN' ? 'in' : 'out'}. Account status: ${employee.status}. Please contact HR.`
            });
        }
        // Check for duplicate within last minute
        logger_1.logger.info('Checking for recent attendance record');
        const oneMinuteAgo = new Date(Date.now() - 60000);
        const recentRecord = await prisma_1.prisma.attendanceLog.findFirst({
            where: {
                employeeId: employee.id,
                eventType: normalizedType,
                timestamp: { gte: oneMinuteAgo },
            },
        });
        if (recentRecord) {
            logger_1.logger.info('Duplicate attendance detected, returning 400');
            return res.status(400).json({
                error: 'Duplicate attendance record. Please wait a moment before trying again.'
            });
        }
        // For clock out, check if there's a clock in today
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (normalizedType === 'CLOCK_OUT') {
            const todayClockIn = await prisma_1.prisma.attendanceLog.findFirst({
                where: {
                    employeeId: employee.id,
                    eventType: 'CLOCK_IN',
                    timestamp: { gte: today },
                },
            });
            if (!todayClockIn) {
                return res.status(400).json({
                    error: 'No clock in record found for today. Please clock in first.'
                });
            }
        }
        // Determine if late
        let status = 'on_time';
        if (normalizedType === 'CLOCK_IN' && employee.shift) {
            const [shiftHour, shiftMin] = employee.shift.startTime.split(':').map(Number);
            const graceMinutes = 15;
            const lateThreshold = new Date(today);
            lateThreshold.setHours(shiftHour, shiftMin + graceMinutes, 0, 0);
            const now = new Date(timestamp || Date.now());
            if (now > lateThreshold) {
                status = 'late';
            }
        }
        // Create attendance record
        logger_1.logger.info('Creating attendanceLog record');
        const attendance = await prisma_1.prisma.attendanceLog.create({
            data: {
                id: (0, crypto_1.randomUUID)(),
                employeeId: employee.id,
                eventType: normalizedType,
                timestamp: timestamp ? new Date(timestamp) : new Date(),
                verifyMethod: verificationMethod.toUpperCase(),
                terminalId,
            },
        });
        // Create or update TimeEntry records for real-time time tracking
        try {
            const attendanceTime = attendance.timestamp;
            const attendanceDay = new Date(attendanceTime);
            attendanceDay.setHours(0, 0, 0, 0);
            if (normalizedType === 'CLOCK_IN') {
                // If there's no open time entry for today, create one
                const existingOpen = await prisma_1.prisma.timeEntry.findFirst({
                    where: {
                        employeeId: employee.id,
                        clockIn: { gte: attendanceDay },
                        clockOut: null,
                    }
                });
                if (!existingOpen) {
                    await prisma_1.prisma.timeEntry.create({
                        data: {
                            id: (0, crypto_1.randomUUID)(),
                            employeeId: employee.id,
                            clockIn: attendanceTime,
                            status: 'clocked_in',
                            location: location || 'Kiosk',
                            terminalId,
                            verifyMethod: attendance.verifyMethod,
                            updatedAt: new Date()
                        }
                    });
                    logger_1.logger.info(`TimeEntry created for ${employee.employeeId} (clock in)`);
                }
            }
            else if (normalizedType === 'CLOCK_OUT') {
                // Find today's open time entry and close it
                const openEntry = await prisma_1.prisma.timeEntry.findFirst({
                    where: {
                        employeeId: employee.id,
                        clockIn: { gte: attendanceDay },
                        clockOut: null,
                    },
                    orderBy: { clockIn: 'desc' }
                });
                if (openEntry) {
                    const clockInTime = openEntry.clockIn;
                    const clockOutTime = attendanceTime;
                    const totalHours = Math.max(0, (clockOutTime.getTime() - clockInTime.getTime()) / (1000 * 60 * 60));
                    const regular = Math.min(8, totalHours);
                    const overtime = Math.max(0, totalHours - 8);
                    await prisma_1.prisma.timeEntry.update({
                        where: { id: openEntry.id },
                        data: {
                            clockOut: clockOutTime,
                            status: 'clocked_out',
                            totalHours,
                            regularHours: regular,
                            overtimeHours: overtime,
                            updatedAt: new Date()
                        }
                    });
                    logger_1.logger.info(`TimeEntry closed for ${employee.employeeId} (clock out)`);
                }
            }
        }
        catch (timeErr) {
            logger_1.logger.error('TimeEntry handling error:', timeErr && (timeErr.stack || timeErr));
        }
        logger_1.logger.info('Attendance created, emitting socket event');
        // Emit real-time event
        if (global.io) {
            global.io.to('attendance-updates').emit('attendance:event', {
                type: normalizedType,
                employee: {
                    id: employee.id,
                    employeeId: employee.employeeId,
                    firstName: employee.firstName,
                    lastName: employee.lastName,
                    department: employee.department?.name,
                },
                timestamp: attendance.timestamp,
            });
        }
        logger_1.logger.info(`Attendance recorded: ${employee.employeeId} - ${normalizedType} at ${attendance.timestamp}`);
        const now = new Date(attendance.timestamp);
        const timeStr = now.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
        res.status(201).json({
            success: true,
            message: normalizedType === 'CLOCK_IN'
                ? `Welcome, ${employee.firstName}! Clocked in at ${timeStr}`
                : `Goodbye, ${employee.firstName}! Clocked out at ${timeStr}`,
            data: {
                id: attendance.id,
                employeeId: employee.employeeId,
                employeeName: `${employee.firstName} ${employee.lastName}`,
                department: employee.department?.name,
                type: normalizedType,
                timestamp: attendance.timestamp,
            },
        });
    }
    catch (error) {
        logger_1.logger.error('Attendance record error:', error);
        res.status(500).json({ error: 'Failed to record attendance: ' + error.message });
    }
});
// Get today's attendance for employee (for kiosk display)
app.get('/api/attendance/today/:employeeId', async (req, res, next) => {
    try {
        const searchId = req.params.employeeId;
        const employee = await prisma_1.prisma.employee.findFirst({
            where: {
                OR: [
                    { id: searchId },
                    { employeeId: searchId },
                ],
            },
        });
        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const records = await prisma_1.prisma.attendanceLog.findMany({
            where: {
                employeeId: employee.id,
                timestamp: { gte: today },
            },
            orderBy: { timestamp: 'asc' },
        });
        const clockIn = records.find(r => r.eventType === 'CLOCK_IN');
        const clockOut = records.find(r => r.eventType === 'CLOCK_OUT');
        res.json({
            employeeId: employee.id,
            employeeName: `${employee.firstName} ${employee.lastName}`,
            date: today.toISOString().split('T')[0],
            clockedIn: !!clockIn,
            clockedOut: !!clockOut,
            clockInTime: clockIn?.timestamp,
            clockOutTime: clockOut?.timestamp,
            records,
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to get attendance' });
    }
});
// ============================================
// AUTHENTICATED API ROUTES
// All routes below require JWT authentication
// ============================================
app.use('/api/auth', auth_2.default);
app.use('/api/employees', auth_1.authMiddleware, employees_1.default);
app.use('/api/departments', auth_1.authMiddleware, departments_1.default);
app.use('/api/shifts', auth_1.authMiddleware, shifts_1.default);
app.use('/api/time-entries', auth_1.authMiddleware, timeEntries_1.default);
app.use('/api/attendance', auth_1.authMiddleware, attendance_1.default);
app.use('/api/leaves', auth_1.authMiddleware, leaves_1.default);
app.use('/api/reports', auth_1.authMiddleware, reports_1.default);
app.use('/api/settings', auth_1.authMiddleware, settings_1.default);
app.use('/api/terminals', auth_1.authMiddleware, terminals_1.default);
app.use('/api/dashboard', auth_1.authMiddleware, dashboard_1.default);
app.use('/api/users', auth_1.authMiddleware, users_1.default);
app.use('/api/payroll', auth_1.authMiddleware, payroll_1.default);
// Error handling
app.use(errorHandler_1.errorHandler);
// Socket.IO event handlers
io.on('connection', (socket) => {
    logger_1.logger.info(`Client connected: ${socket.id}`);
    socket.on('subscribe:attendance', (data) => {
        socket.join('attendance-updates');
        logger_1.logger.info(`Client ${socket.id} subscribed to attendance updates`);
    });
    socket.on('disconnect', () => {
        logger_1.logger.info(`Client disconnected: ${socket.id}`);
    });
});
// Broadcast attendance event to all connected clients
const broadcastAttendanceEvent = (event) => {
    io.to('attendance-updates').emit('attendance:event', event);
};
exports.broadcastAttendanceEvent = broadcastAttendanceEvent;
const PORT = process.env.PORT || 3000;
// Readiness endpoint checks DB connectivity
app.get('/ready', async (req, res) => {
    try {
        // simple DB ping
        await prisma_1.prisma.$queryRaw `SELECT 1`;
        res.json({ ready: true });
    }
    catch (err) {
        logger_1.logger.error('Readiness check failed:', err && (err.stack || err));
        res.status(503).json({ ready: false, error: String(err) });
    }
});
async function startServer() {
    try {
        // Connect DB
        await prisma_1.prisma.$connect();
        logger_1.logger.info('Database connected');
        // Initialize default data
        await (0, seedData_1.initializeDefaultData)();
        const serverPort = Number(PORT);
        // Handle port-in-use error gracefully
        httpServer.on('error', (err) => {
            if (err && err.code === 'EADDRINUSE') {
                logger_1.logger.error(`Port ${serverPort} is already in use. Please stop the process using that port or change the PORT environment variable.`);
            }
            else {
                logger_1.logger.error('HTTP server error while binding:', err && (err.stack || err));
            }
            process.exit(1);
        });
        httpServer.listen(serverPort, () => {
            logger_1.logger.info(`Server running on http://localhost:${serverPort}`);
            logger_1.logger.info(`WebSocket server running on ws://localhost:${serverPort}`);
            logger_1.logger.info('Kiosk endpoints available (no auth required):');
            logger_1.logger.info('  GET  /api/employees/lookup/:id');
            logger_1.logger.info('  GET  /api/employees/fingerprint-template/:id');
            logger_1.logger.info('  POST /api/employees/fingerprint-enroll/:id');
            logger_1.logger.info('  POST /api/attendance/record');
            logger_1.logger.info('  GET  /api/attendance/today/:id');
        });
        await global.hikvisionService.initialize();
    }
    catch (error) {
        logger_1.logger.error('Failed to start server:', error);
        process.exit(1);
    }
}
// Graceful shutdown
process.on('SIGTERM', async () => {
    logger_1.logger.info('SIGTERM received, shutting down gracefully');
    await prisma_1.prisma.$disconnect();
    global.hikvisionService.stopPolling();
    process.exit(0);
});
startServer();
//# sourceMappingURL=index.js.map