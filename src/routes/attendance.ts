// ============================================
// routes/attendance.ts - Complete with Kiosk Support
// ============================================

import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuthRequest, requirePermission } from '../middleware/auth';
import { randomUUID } from 'crypto';

const router = Router();

// ============================================
// KIOSK ENDPOINTS (No Auth Required)
// Fingerprint verification IS the authentication
// ============================================

// Record attendance from kiosk (PUBLIC - no JWT auth needed)
router.post('/record', async (req: Request, res: Response): Promise<any> => {
  try {
    const { 
      employeeId,  // Can be UUID or employee number
      type,        // 'clock_in' or 'clock_out' or 'CLOCK_IN' or 'CLOCK_OUT'
      timestamp, 
      verificationMethod = 'FINGERPRINT',
      location = 'Kiosk',
      terminalId,
      confidence
    } = req.body;

    // Validate required fields
    if (!employeeId || !type) {
      return res.status(400).json({ error: 'employeeId and type are required' });
    }

    // Normalize type
    const normalizedType = type.toUpperCase();
    if (!['CLOCK_IN', 'CLOCK_OUT'].includes(normalizedType)) {
      return res.status(400).json({ error: 'Invalid attendance type. Use clock_in or clock_out' });
    }

    // Find employee
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

    // Check if employee is active
    if (employee.status !== 'active') {
      return res.status(403).json({ 
        error: `Cannot clock ${normalizedType === 'CLOCK_IN' ? 'in' : 'out'}. Account status: ${employee.status}. Please contact HR.` 
      });
    }

    // Check for duplicate within last minute
    const oneMinuteAgo = new Date(Date.now() - 60000);
    const recentRecord = await prisma.attendanceLog.findFirst({
      where: {
        employeeId: employee.id,
        eventType: normalizedType,
        timestamp: { gte: oneMinuteAgo },
      },
    });

    if (recentRecord) {
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

    // Determine if late (for clock in)
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
    const attendanceData: any = {
      id: randomUUID(),
      employeeId: employee.id,
      eventType: normalizedType,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      verifyMethod: verificationMethod.toUpperCase(),
    };

    if (terminalId) {
      attendanceData.terminalId = terminalId;
    }

    const attendance = await prisma.attendanceLog.create({
      data: attendanceData,
    });

    // ============================================
    // PROCESS INTO TIME ENTRY FOR DASHBOARD
    // ============================================
    try {
      const attendanceTime = attendance.timestamp;
      const attendanceToday = new Date(attendanceTime);
      attendanceToday.setHours(0, 0, 0, 0);

      if (normalizedType === 'CLOCK_IN') {
        // Check if there's already a clock in today
        const existingEntry = await prisma.timeEntry.findFirst({
          where: {
            employeeId: employee.id,
            clockIn: { gte: attendanceToday },
            clockOut: null
          }
        });

        if (!existingEntry) {
          // Create new TimeEntry for clock in
          await prisma.timeEntry.create({
            data: {
              id: randomUUID(),
              employeeId: employee.id,
              clockIn: attendanceTime,
              status: 'clocked_in',
              location: location || 'Kiosk',
              terminalId,
              verifyMethod: verificationMethod.toUpperCase(),
              updatedAt: new Date()
            }
          });
          logger.info(`TimeEntry created for clock in: ${employee.employeeId}`);
        }
      } else if (normalizedType === 'CLOCK_OUT') {
        // Find the clock in entry for today
        const timeEntry = await prisma.timeEntry.findFirst({
          where: {
            employeeId: employee.id,
            clockIn: { gte: attendanceToday },
            clockOut: null
          }
        });

        if (timeEntry) {
          // Calculate hours
          const clockInTime = new Date(timeEntry.clockIn);
          const clockOutTime = attendanceTime;
          const totalHours = (clockOutTime.getTime() - clockInTime.getTime()) / (1000 * 60 * 60);
          const regularHours = Math.min(totalHours, 8);
          const overtimeHours = Math.max(0, totalHours - 8);

          // Update TimeEntry with clock out
          await prisma.timeEntry.update({
            where: { id: timeEntry.id },
            data: {
              clockOut: clockOutTime,
              totalHours: Math.round(totalHours * 100) / 100,
              regularHours: Math.round(regularHours * 100) / 100,
              overtimeHours: Math.round(overtimeHours * 100) / 100,
              status: 'clocked_out',
              updatedAt: new Date()
            }
          });
          logger.info(`TimeEntry updated for clock out: ${employee.employeeId} (${regularHours.toFixed(2)} hours)`);
        }
      }
    } catch (timeEntryError: any) {
      logger.error('Error creating/updating TimeEntry:', timeEntryError);
      // Don't fail the attendance record if TimeEntry creation fails
    }

    // Emit real-time event if socket.io is available
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

    // Format response
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
    console.error('Attendance record error:', error);
    logger.error('Attendance record error:', error);
    res.status(500).json({ error: 'Failed to record attendance: ' + error.message });
  }
});

/**
 * Clock In - Convenience endpoint
 * POST /attendance/clock-in
 * Wraps /record endpoint with type='CLOCK_IN'
 */
router.post('/clock-in', async (req: Request, res: Response): Promise<any> => {
  try {
    const { employeeId, ...otherData } = req.body;
    
    if (!employeeId) {
      return res.status(400).json({ error: 'employeeId is required' });
    }

    // Call the record endpoint logic
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
        error: 'Cannot clock in. Account status: ' + employee.status + '. Please contact HR.' 
      });
    }

    // Check for duplicate within last minute
    const oneMinuteAgo = new Date(Date.now() - 60000);
    const recentRecord = await prisma.attendanceLog.findFirst({
      where: {
        employeeId: employee.id,
        eventType: 'CLOCK_IN',
        timestamp: { gte: oneMinuteAgo },
      },
    });

    if (recentRecord) {
      return res.status(400).json({ 
        error: 'Duplicate clock in. Please wait a moment before trying again.' 
      });
    }

    // Create attendance record
    const attendance = await prisma.attendanceLog.create({
      data: {
        id: randomUUID(),
        employeeId: employee.id,
        eventType: 'CLOCK_IN',
        timestamp: otherData.timestamp ? new Date(otherData.timestamp) : new Date(),
        verifyMethod: (otherData.verifyMethod || 'FINGERPRINT').toUpperCase(),
        terminalId: otherData.terminalId,
      },
    });

    // Create TimeEntry
    try {
      const attendanceTime = attendance.timestamp;
      const attendanceToday = new Date(attendanceTime);
      attendanceToday.setHours(0, 0, 0, 0);

      const existingEntry = await prisma.timeEntry.findFirst({
        where: {
          employeeId: employee.id,
          clockIn: { gte: attendanceToday },
          clockOut: null
        }
      });

      if (!existingEntry) {
        await prisma.timeEntry.create({
          data: {
            id: randomUUID(),
            employeeId: employee.id,
            clockIn: attendanceTime,
            status: 'clocked_in',
            location: otherData.location || 'Kiosk',
            terminalId: otherData.terminalId,
            verifyMethod: attendance.verifyMethod,
            updatedAt: new Date()
          }
        });
        logger.info(`TimeEntry created for clock in: ${employee.employeeId}`);
      }
    } catch (timeEntryError: any) {
      logger.error('Error creating TimeEntry:', timeEntryError);
    }

    // Emit real-time event
    if (global.io) {
      global.io.to('attendance-updates').emit('attendance:event', {
        type: 'CLOCK_IN',
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

    const now = new Date(attendance.timestamp);
    const timeStr = now.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    });

    res.status(201).json({
      success: true,
      message: `Welcome, ${employee.firstName}! Clocked in at ${timeStr}`,
      data: {
        id: attendance.id,
        employeeId: employee.employeeId,
        employeeName: `${employee.firstName} ${employee.lastName}`,
        department: employee.department?.name,
        type: 'CLOCK_IN',
        timestamp: attendance.timestamp,
      },
    });
  } catch (error: any) {
    logger.error('Clock in error:', error);
    res.status(500).json({ error: 'Failed to clock in: ' + error.message });
  }
});

/**
 * Clock Out - Convenience endpoint
 * POST /attendance/clock-out
 * Wraps /record endpoint with type='CLOCK_OUT'
 */
router.post('/clock-out', async (req: Request, res: Response): Promise<any> => {
  try {
    const { employeeId, ...otherData } = req.body;
    
    if (!employeeId) {
      return res.status(400).json({ error: 'employeeId is required' });
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
        error: 'Cannot clock out. Account status: ' + employee.status + '. Please contact HR.' 
      });
    }

    // Check for duplicate within last minute
    const oneMinuteAgo = new Date(Date.now() - 60000);
    const recentRecord = await prisma.attendanceLog.findFirst({
      where: {
        employeeId: employee.id,
        eventType: 'CLOCK_OUT',
        timestamp: { gte: oneMinuteAgo },
      },
    });

    if (recentRecord) {
      return res.status(400).json({ 
        error: 'Duplicate clock out. Please wait a moment before trying again.' 
      });
    }

    // Check if there's a clock in today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

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

    // Create attendance record
    const attendance = await prisma.attendanceLog.create({
      data: {
        id: randomUUID(),
        employeeId: employee.id,
        eventType: 'CLOCK_OUT',
        timestamp: otherData.timestamp ? new Date(otherData.timestamp) : new Date(),
        verifyMethod: (otherData.verifyMethod || 'FINGERPRINT').toUpperCase(),
        terminalId: otherData.terminalId,
      },
    });

    // Update TimeEntry
    try {
      const attendanceTime = attendance.timestamp;
      const attendanceToday = new Date(attendanceTime);
      attendanceToday.setHours(0, 0, 0, 0);

      const timeEntry = await prisma.timeEntry.findFirst({
        where: {
          employeeId: employee.id,
          clockIn: { gte: attendanceToday },
          clockOut: null
        }
      });

      if (timeEntry) {
        const clockInTime = new Date(timeEntry.clockIn);
        const clockOutTime = attendanceTime;
        const totalHours = (clockOutTime.getTime() - clockInTime.getTime()) / (1000 * 60 * 60);
        const regularHours = Math.min(totalHours, 8);
        const overtimeHours = Math.max(0, totalHours - 8);

        await prisma.timeEntry.update({
          where: { id: timeEntry.id },
          data: {
            clockOut: clockOutTime,
            totalHours: Math.round(totalHours * 100) / 100,
            regularHours: Math.round(regularHours * 100) / 100,
            overtimeHours: Math.round(overtimeHours * 100) / 100,
            status: 'clocked_out',
            updatedAt: new Date()
          }
        });
        logger.info(`TimeEntry updated for clock out: ${employee.employeeId} (${regularHours.toFixed(2)} hours)`);
      }
    } catch (timeEntryError: any) {
      logger.error('Error updating TimeEntry:', timeEntryError);
    }

    // Emit real-time event
    if (global.io) {
      global.io.to('attendance-updates').emit('attendance:event', {
        type: 'CLOCK_OUT',
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

    const now = new Date(attendance.timestamp);
    const timeStr = now.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    });

    res.status(201).json({
      success: true,
      message: `Goodbye, ${employee.firstName}! Clocked out at ${timeStr}`,
      data: {
        id: attendance.id,
        employeeId: employee.employeeId,
        employeeName: `${employee.firstName} ${employee.lastName}`,
        department: employee.department?.name,
        type: 'CLOCK_OUT',
        timestamp: attendance.timestamp,
      },
    });
  } catch (error: any) {
    logger.error('Clock out error:', error);
    res.status(500).json({ error: 'Failed to clock out: ' + error.message });
  }
});

// Get employee's attendance for today (PUBLIC - for kiosk display)
router.get('/today/:employeeId', async (req: Request, res: Response): Promise<any> => {
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
      employeeId: employee.employeeId,
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
// AUTHENTICATED ENDPOINTS (Require Auth)
// ============================================

// Get attendance records with filters
router.get('/', requirePermission('attendance:read'), asyncHandler(async (req: AuthRequest, res: any) => {
  const { 
    employeeId, 
    departmentId, 
    startDate, 
    endDate, 
    eventType,
    limit = '100', 
    offset = '0' 
  } = req.query;

  const where: any = {};

  if (employeeId) {
    where.employeeId = employeeId;
  }

  if (departmentId) {
    where.Employee = {
      departmentId,
    };
  }

  if (eventType) {
    where.eventType = eventType.toString().toUpperCase();
  }

  if (startDate || endDate) {
    where.timestamp = {};
    if (startDate) {
      where.timestamp.gte = new Date(startDate as string);
    }
    if (endDate) {
      where.timestamp.lte = new Date(endDate as string);
    }
  }

  const [records, total] = await Promise.all([
    prisma.attendanceLog.findMany({
      where,
      include: {
        Employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            department: { select: { name: true } },
            shift: { select: { name: true } },
          },
        },
        Terminal: { select: { id: true, name: true, location: true } },
      },
      orderBy: { timestamp: 'desc' },
      take: parseInt(limit as string),
      skip: parseInt(offset as string),
    }),
    prisma.attendanceLog.count({ where }),
  ]);

  res.json({ records, total, limit: parseInt(limit as string), offset: parseInt(offset as string) });
}));

// Get today's attendance summary
router.get('/summary/today', requirePermission('attendance:read'), asyncHandler(async (req: AuthRequest, res: any) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Get today's clock-ins
  const clockIns = await prisma.attendanceLog.findMany({
    where: {
      eventType: 'CLOCK_IN',
      timestamp: {
        gte: today,
        lt: tomorrow,
      },
    },
    include: {
      Employee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      },
    },
    orderBy: { timestamp: 'desc' },
  });

  // Get total active employees
  const totalEmployees = await prisma.employee.count({
    where: { status: 'active' },
  });

  // Count unique employees who clocked in
  const presentEmployees = new Set(clockIns.map(r => r.employeeId));
  const lateCount = 0; // status field removed from AttendanceLog

  res.json({
    date: today.toISOString().split('T')[0],
    summary: {
      total: totalEmployees,
      present: presentEmployees.size,
      absent: totalEmployees - presentEmployees.size,
      late: lateCount,
      onTime: presentEmployees.size - lateCount,
    },
    recentClockIns: clockIns.slice(0, 10),
  });
}));

// Get monthly attendance summary
router.get('/summary/monthly', requirePermission('attendance:read'), asyncHandler(async (req: AuthRequest, res: any) => {
  const { departmentId, month, year } = req.query;

  const startDate = new Date(
    parseInt(year as string) || new Date().getFullYear(),
    (parseInt(month as string) || new Date().getMonth()),
    1
  );

  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + 1);

  const records = await prisma.attendanceLog.findMany({
    where: {
      timestamp: {
        gte: startDate,
        lt: endDate,
      },
      ...(departmentId && {
        Employee: {
          departmentId: departmentId as string,
        },
      }),
    },
    include: {
      Employee: {
        select: {
          employeeId: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      },
    },
    orderBy: { timestamp: 'asc' },
  });

  // Aggregate by employee
  const summary: Record<string, any> = {};
  
  records.forEach((record) => {
    const key = record.employeeId;
    if (!summary[key]) {
      summary[key] = {
        employeeId: key,
        firstName: record.Employee.firstName,
        lastName: record.Employee.lastName,
        department: record.Employee.department?.name,
        clockIns: 0,
        clockOuts: 0,
        lateCount: 0,
        workDays: new Set(),
      };
    }

    const dateKey = record.timestamp.toISOString().split('T')[0];
    summary[key].workDays.add(dateKey);

    if (record.eventType === 'CLOCK_IN') {
      summary[key].clockIns++;
    } else if (record.eventType === 'CLOCK_OUT') {
      summary[key].clockOuts++;
    }
  });

  // Convert Sets to counts
  const result = Object.values(summary).map((emp: any) => ({
    ...emp,
    workDays: emp.workDays.size,
  }));

  res.json({
    month: startDate.getMonth() + 1,
    year: startDate.getFullYear(),
    data: result,
  });
}));

// Manual attendance entry (admin only)
router.post('/manual', requirePermission('attendance:write'), asyncHandler(async (req: AuthRequest, res: any) => {
  const { employeeId, type, timestamp, notes } = req.body;

  if (!employeeId || !type || !timestamp) {
    throw new AppError('employeeId, type, and timestamp are required', 400);
  }

  const employee = await prisma.employee.findFirst({
    where: {
      OR: [
        { id: employeeId },
        { employeeId: employeeId },
      ],
    },
  });

  if (!employee) {
    throw new AppError('Employee not found', 404);
  }

  const attendance = await prisma.attendanceLog.create({
    data: {
      id: randomUUID(),
      employeeId: employee.id,
      eventType: type.toUpperCase(),
      timestamp: new Date(timestamp),
      verifyMethod: 'MANUAL',
    },
  });

  // Create audit log
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'manual_attendance',
      entityType: 'attendance',
      entityId: attendance.id,
      newValue: JSON.stringify(attendance),
    },
  });

  res.status(201).json({
    success: true,
    message: 'Attendance recorded manually',
    data: attendance,
  });
}));

// Delete attendance record (admin only)
router.delete('/:id', requirePermission('attendance:delete'), asyncHandler(async (req: AuthRequest, res: any) => {
  const record = await prisma.attendanceLog.findUnique({
    where: { id: req.params.id },
  });

  if (!record) {
    throw new AppError('Attendance record not found', 404);
  }

  await prisma.attendanceLog.delete({
    where: { id: req.params.id },
  });

  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'delete',
      entityType: 'attendance',
      entityId: req.params.id,
      oldValue: JSON.stringify(record),
    },
  });

  res.json({ success: true, message: 'Attendance record deleted' });
}));

export default router;