// ============================================
// index.ts - Main Server Entry Point
// With proper Kiosk route configuration
// ============================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import path from 'path';

import { prisma } from './utils/prisma';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { authMiddleware } from './middleware/auth';

// Routes
import authRoutes from './routes/auth';
import employeeRoutes from './routes/employees';
import departmentRoutes from './routes/departments';
import shiftRoutes from './routes/shifts';
import timeEntryRoutes from './routes/timeEntries';
import attendanceRoutes from './routes/attendance';
import leaveRoutes from './routes/leaves';
import reportRoutes from './routes/reports';
import settingsRoutes from './routes/settings';
import terminalRoutes from './routes/terminals';
import dashboardRoutes from './routes/dashboard';
import userRoutes from './routes/users';
import payrollRoutes from './routes/payroll';

// Services
import { initializeDefaultData } from './utils/seedData';
import { randomUUID } from 'crypto';

// Hikvision Service stub - can be implemented later
class HikvisionService {
  async initialize() {
    // Initialize Hikvision service
  }
  stopPolling() {
    // Stop polling
  }
}

dotenv.config();

const app = express();
const httpServer = createServer(app);

// Log raw TCP connections to help debug sudden crashes on request
httpServer.on('connection', (socket) => {
  try {
    const remote = socket.remoteAddress + ':' + socket.remotePort;
    logger.info(`Raw connection from ${remote}`);
  } catch (e) {
    logger.error('Error logging raw connection', e);
  }
});

// Socket.IO for real-time updates
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Make io accessible globally
declare global {
  var io: SocketIOServer;
  var hikvisionService: HikvisionService;
}
global.io = io;
global.hikvisionService = new HikvisionService();

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(cors({
  origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Basic request logger for debugging crashing requests
app.use((req, res, next) => {
  logger.info(`Incoming request: ${req.method} ${req.url}`);
  next();
});

// Catch global errors so we can log stack traces instead of crashing silently
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', (reason: any) => {
  logger.error('Unhandled Rejection:', reason && (reason.stack || reason));
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000 // limit each IP to 1000 requests per windowMs
});
app.use('/api', limiter);

// Static files for uploads
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

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
    
    const employee = await prisma.employee.findFirst({
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
    const fingerprint = await prisma.biometricData.findFirst({
      where: { 
        employeeId: employee.id,
        type: 'FINGERPRINT' 
      },
    });

    // Get today's attendance
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayAttendance = await prisma.attendanceLog.findMany({
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
  } catch (error: any) {
    logger.error('Employee lookup error:', error);
    res.status(500).json({ error: 'Failed to lookup employee' });
  }
});

// Get fingerprint template for kiosk verification
app.get('/api/employees/fingerprint-template/:employeeId', async (req, res, next) => {
  try {
    const searchId = req.params.employeeId;
    
    const employee = await prisma.employee.findFirst({
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

    const biometric = await prisma.biometricData.findFirst({
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
  } catch (error: any) {
    logger.error('Get fingerprint template error:', error);
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

    const employee = await prisma.employee.findFirst({
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
    const existingBiometric = await prisma.biometricData.findFirst({
      where: {
        employeeId: employee.id,
        type: 'FINGERPRINT',
        fingerNo: fingerNo,
      },
    });

    let biometric;
    if (existingBiometric) {
      biometric = await prisma.biometricData.update({
        where: { id: existingBiometric.id },
        data: {
          data: template,
          enrolledAt: new Date(),
        },
      });
      logger.info(`Fingerprint updated for employee ${employee.employeeId}`);
    } else {
      biometric = await prisma.biometricData.create({
        data: {
          id: randomUUID(),
          employeeId: employee.id,
          type: 'FINGERPRINT',
          data: template,
          fingerNo,
          enrolledAt: new Date(),
        },
      });
      logger.info(`Fingerprint enrolled for employee ${employee.employeeId}`);
    }

    // Update employee fingerprint status
    await prisma.employee.update({
      where: { id: employee.id },
      data: { fingerprintEnrolled: true },
    });

    res.json({
      success: true,
      message: 'Fingerprint enrolled successfully',
      biometricId: biometric.id,
      employeeId: employee.employeeId,
    });
  } catch (error: any) {
    logger.error('Fingerprint enrollment error:', error);
    res.status(500).json({ error: 'Failed to enroll fingerprint: ' + error.message });
  }
});

// Record attendance from kiosk (fingerprint is the auth)
app.post('/api/attendance/record', async (req, res, next) => {
  try {
    logger.info('Entered /api/attendance/record handler');
    logger.info(`Payload: ${JSON.stringify(req.body).slice(0, 200)}`);
    const { 
      employeeId,
      type,
      timestamp, 
      verificationMethod = 'FINGERPRINT',
      location = 'Kiosk',
      terminalId,
    } = req.body;

    if (!employeeId || !type) {
      return res.status(400).json({ error: 'employeeId and type are required' });
    }

    const normalizedType = type.toUpperCase();
    if (!['CLOCK_IN', 'CLOCK_OUT'].includes(normalizedType)) {
      return res.status(400).json({ error: 'Invalid attendance type. Use clock_in or clock_out' });
    }

    const employee = await prisma.employee.findFirst({
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
    logger.info('Checking for recent attendance record');
    const oneMinuteAgo = new Date(Date.now() - 60000);
    const recentRecord = await prisma.attendanceLog.findFirst({
      where: {
        employeeId: employee.id,
        eventType: normalizedType,
        timestamp: { gte: oneMinuteAgo },
      },
    });

    if (recentRecord) {
      logger.info('Duplicate attendance detected, returning 400');
      return res.status(400).json({ 
        error: 'Duplicate attendance record. Please wait a moment before trying again.' 
      });
    }

    // For clock out, check if there's a clock in today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (normalizedType === 'CLOCK_OUT') {
      const todayClockIn = await prisma.attendanceLog.findFirst({
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
    logger.info('Creating attendanceLog record');
    const attendance = await prisma.attendanceLog.create({
      data: {
        id: randomUUID(),
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
        const existingOpen = await prisma.timeEntry.findFirst({
          where: {
            employeeId: employee.id,
            clockIn: { gte: attendanceDay },
            clockOut: null,
          }
        });

        if (!existingOpen) {
          await prisma.timeEntry.create({
            data: {
              id: randomUUID(),
              employeeId: employee.id,
              clockIn: attendanceTime,
              status: 'clocked_in',
              location: location || 'Kiosk',
              terminalId,
              verifyMethod: attendance.verifyMethod,
              updatedAt: new Date()
            }
          });
          logger.info(`TimeEntry created for ${employee.employeeId} (clock in)`);
        }
      } else if (normalizedType === 'CLOCK_OUT') {
        // Find today's open time entry and close it
        const openEntry = await prisma.timeEntry.findFirst({
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

          await prisma.timeEntry.update({
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
          logger.info(`TimeEntry closed for ${employee.employeeId} (clock out)`);
        }
      }
    } catch (timeErr: any) {
      logger.error('TimeEntry handling error:', timeErr && (timeErr.stack || timeErr));
    }

    logger.info('Attendance created, emitting socket event');
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

    logger.info(`Attendance recorded: ${employee.employeeId} - ${normalizedType} at ${attendance.timestamp}`);

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

  } catch (error: any) {
    logger.error('Attendance record error:', error);
    res.status(500).json({ error: 'Failed to record attendance: ' + error.message });
  }
});

// Get today's attendance for employee (for kiosk display)
app.get('/api/attendance/today/:employeeId', async (req, res, next) => {
  try {
    const searchId = req.params.employeeId;
    
    const employee = await prisma.employee.findFirst({
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

    const records = await prisma.attendanceLog.findMany({
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
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to get attendance' });
  }
});

// ============================================
// AUTHENTICATED API ROUTES
// All routes below require JWT authentication
// ============================================

app.use('/api/auth', authRoutes);
app.use('/api/employees', authMiddleware, employeeRoutes);
app.use('/api/departments', authMiddleware, departmentRoutes);
app.use('/api/shifts', authMiddleware, shiftRoutes);
app.use('/api/time-entries', authMiddleware, timeEntryRoutes);
app.use('/api/attendance', authMiddleware, attendanceRoutes);
app.use('/api/leaves', authMiddleware, leaveRoutes);
app.use('/api/reports', authMiddleware, reportRoutes);
app.use('/api/settings', authMiddleware, settingsRoutes);
app.use('/api/terminals', authMiddleware, terminalRoutes);
app.use('/api/dashboard', authMiddleware, dashboardRoutes);
app.use('/api/users', authMiddleware, userRoutes);
app.use('/api/payroll', authMiddleware, payrollRoutes);

// Error handling
app.use(errorHandler);

// Socket.IO event handlers
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);
  
  socket.on('subscribe:attendance', (data) => {
    socket.join('attendance-updates');
    logger.info(`Client ${socket.id} subscribed to attendance updates`);
  });
  
  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// Broadcast attendance event to all connected clients
export const broadcastAttendanceEvent = (event: any) => {
  io.to('attendance-updates').emit('attendance:event', event);
};

const PORT = process.env.PORT || 3000;

// Readiness endpoint checks DB connectivity
app.get('/ready', async (req, res) => {
  try {
    // simple DB ping
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ready: true });
  } catch (err: any) {
    logger.error('Readiness check failed:', err && (err.stack || err));
    res.status(503).json({ ready: false, error: String(err) });
  }
});

async function startServer() {
  try {
    // Connect DB
    await prisma.$connect();
    logger.info('Database connected');

    // Initialize default data
    await initializeDefaultData();

    const serverPort = Number(PORT);

    // Handle port-in-use error gracefully
    httpServer.on('error', (err: any) => {
      if (err && err.code === 'EADDRINUSE') {
        logger.error(`Port ${serverPort} is already in use. Please stop the process using that port or change the PORT environment variable.`);
      } else {
        logger.error('HTTP server error while binding:', err && (err.stack || err));
      }
      process.exit(1);
    });

    httpServer.listen(serverPort, () => {
      logger.info(`Server running on http://localhost:${serverPort}`);
      logger.info(`WebSocket server running on ws://localhost:${serverPort}`);
      logger.info('Kiosk endpoints available (no auth required):');
      logger.info('  GET  /api/employees/lookup/:id');
      logger.info('  GET  /api/employees/fingerprint-template/:id');
      logger.info('  POST /api/employees/fingerprint-enroll/:id');
      logger.info('  POST /api/attendance/record');
      logger.info('  GET  /api/attendance/today/:id');
    });

    await global.hikvisionService.initialize();
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await prisma.$disconnect();
  global.hikvisionService.stopPolling();
  process.exit(0);
});

startServer();

export { app, io };