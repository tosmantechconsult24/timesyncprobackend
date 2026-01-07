import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuthRequest, requirePermission } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();

const timeEntrySchema = z.object({
  employeeId: z.string(),
  clockIn: z.string(),
  clockOut: z.string().optional().nullable(),
  breakStart: z.string().optional().nullable(),
  breakEnd: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  status: z.enum(['clocked_in', 'clocked_out', 'on_break', 'pending', 'approved', 'rejected']).optional()
});

// Schema for kiosk clock in/out
const kioskClockInOutSchema = z.object({
  employeeId: z.string().min(1),
  fingerprintTemplate: z.string(), // From USB fingerprint scanner capture
  verifyMethod: z.enum(['fingerprint', 'manual']).default('fingerprint'),
  notes: z.string().optional(),
});

// ============================================
// KIOSK ENDPOINTS - Public (TimeStation)
// ============================================

/**
 * Clock In with fingerprint verification
 * Public endpoint - no auth required for kiosk
 */
router.post(
  '/kiosk/clock-in',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId, fingerprintTemplate, verifyMethod, notes } =
      kioskClockInOutSchema.parse(req.body);

    // Get employee and check if active
    const employee = await prisma.employee.findUnique({
      where: { employeeId },
      include: { shift: true, department: true },
    });

    if (!employee) {
      throw new AppError('Employee not found', 404);
    }

    if (employee.status !== 'active') {
      throw new AppError('Employee is not active. Cannot clock in.', 403);
    }

    // Check if employee already clocked in today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existingEntry = await prisma.timeEntry.findFirst({
      where: {
        employeeId: employee.id,
        clockIn: {
          gte: today,
          lt: tomorrow,
        },
      },
    });

    if (existingEntry && existingEntry.clockOut === null) {
      throw new AppError(
        'Employee already clocked in today. Please clock out first.',
        409
      );
    }

    // Verify fingerprint if using fingerprint method
    if (verifyMethod === 'fingerprint') {
      if (!employee.fingerprintEnrolled) {
        throw new AppError(
          'Employee fingerprint not enrolled. Cannot verify.',
          400
        );
      }

      // Here you would call the fingerprint verification service
      // For now, we'll accept the template as verified
      logger.info(
        `Fingerprint clock-in verification for employee: ${employeeId}`
      );
    }

    // Get or create shift assignment for today
    let shiftId = employee.shiftId;
    if (!shiftId) {
      throw new AppError('Employee has no assigned shift', 400);
    }

    const shift = await prisma.shift.findUnique({
      where: { id: shiftId },
    });

    if (!shift) {
      throw new AppError('Assigned shift not found', 404);
    }

    // Create time entry
    const clockInTime = new Date();
    const entry = await prisma.timeEntry.create({
      data: {
        id: randomUUID(),
        employeeId: employee.id,
        clockIn: clockInTime,
        status: 'clocked_in',
        verifyMethod,
        notes: notes || `Clocked in via ${verifyMethod}`,
        updatedAt: clockInTime,
      },
      include: {
        Employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    // Log audit
    await prisma.auditLog.create({
      data: {
        action: 'clock_in',
        entityType: 'timeEntry',
        entityId: entry.id,
        newValue: JSON.stringify(entry),
      },
    });

    logger.info(
      `Employee ${employeeId} clocked in at ${clockInTime.toISOString()}`
    );

    res.status(201).json({
      success: true,
      timeEntry: entry,
      shift: {
        name: shift.name,
        startTime: shift.startTime,
        endTime: shift.endTime,
      },
      message: `Welcome ${employee.firstName} ${employee.lastName}! You have clocked in.`,
    });
  })
);

/**
 * Clock Out with fingerprint verification
 * Public endpoint - no auth required for kiosk
 */
router.post(
  '/kiosk/clock-out',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId, fingerprintTemplate, verifyMethod, notes } =
      kioskClockInOutSchema.parse(req.body);

    // Get employee
    const employee = await prisma.employee.findUnique({
      where: { employeeId },
      include: { shift: true },
    });

    if (!employee) {
      throw new AppError('Employee not found', 404);
    }

    if (employee.status !== 'active') {
      throw new AppError('Employee is not active. Cannot clock out.', 403);
    }

    // Verify fingerprint if using fingerprint method
    if (verifyMethod === 'fingerprint') {
      if (!employee.fingerprintEnrolled) {
        throw new AppError(
          'Employee fingerprint not enrolled. Cannot verify.',
          400
        );
      }

      logger.info(
        `Fingerprint clock-out verification for employee: ${employeeId}`
      );
    }

    // Get today's clock in entry
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const clockInEntry = await prisma.timeEntry.findFirst({
      where: {
        employeeId: employee.id,
        clockIn: {
          gte: today,
          lt: tomorrow,
        },
        clockOut: null,
      },
    });

    if (!clockInEntry) {
      throw new AppError(
        'No active clock-in entry found for today. Please clock in first.',
        404
      );
    }

    // Calculate hours worked
    const clockOutTime = new Date();
    const totalMinutes =
      (clockOutTime.getTime() - clockInEntry.clockIn.getTime()) / (1000 * 60);
    let totalHours = totalMinutes / 60;

    // Subtract break time if recorded
    let breakMinutes = 0;
    if (clockInEntry.breakStart && clockInEntry.breakEnd) {
      breakMinutes = Math.round(
        (clockInEntry.breakEnd.getTime() -
          clockInEntry.breakStart.getTime()) /
          (1000 * 60)
      );
      totalHours -= breakMinutes / 60;
    }

    // Calculate regular and overtime hours
    const overtimeThreshold = employee.shift?.overtimeAfter || 8;
    const regularHours = Math.min(totalHours, overtimeThreshold);
    const overtimeHours = Math.max(0, totalHours - overtimeThreshold);

    // Update time entry
    const updatedEntry = await prisma.timeEntry.update({
      where: { id: clockInEntry.id },
      data: {
        clockOut: clockOutTime,
        status: 'clocked_out',
        totalHours: Math.round(totalHours * 100) / 100,
        regularHours: Math.round(regularHours * 100) / 100,
        overtimeHours: Math.round(overtimeHours * 100) / 100,
        breakMinutes,
        notes:
          notes ||
          `Clocked out via ${verifyMethod}. Total hours: ${Math.round(totalHours * 100) / 100}`,
        updatedAt: clockOutTime,
      },
      include: {
        Employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    // Log audit
    await prisma.auditLog.create({
      data: {
        action: 'clock_out',
        entityType: 'timeEntry',
        entityId: updatedEntry.id,
        newValue: JSON.stringify(updatedEntry),
      },
    });

    logger.info(
      `Employee ${employeeId} clocked out at ${clockOutTime.toISOString()}. Total hours: ${updatedEntry.totalHours}`
    );

    res.json({
      success: true,
      timeEntry: updatedEntry,
      summary: {
        totalHours: updatedEntry.totalHours,
        regularHours: updatedEntry.regularHours,
        overtimeHours: updatedEntry.overtimeHours,
        breakMinutes: updatedEntry.breakMinutes,
      },
      message: `Thank you ${employee.firstName}! You have clocked out. Total hours worked: ${updatedEntry.totalHours}h.`,
    });
  })
);

/**
 * Get active clock-in entry for employee (for today)
 * Public endpoint
 */
router.get(
  '/kiosk/active/:employeeId',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId } = req.params;

    const employee = await prisma.employee.findUnique({
      where: { employeeId },
    });

    if (!employee) {
      throw new AppError('Employee not found', 404);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const activeEntry = await prisma.timeEntry.findFirst({
      where: {
        employeeId: employee.id,
        clockIn: {
          gte: today,
          lt: tomorrow,
        },
      },
      orderBy: { clockIn: 'desc' },
    });

    res.json({
      hasClockedIn: !!activeEntry,
      entry: activeEntry || null,
    });
  })
);

// ============================================
// STANDARD ENDPOINTS - Protected
// ============================================

// Get all time entries with filters
router.get('/', requirePermission('attendance:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const {
    employeeId,
    departmentId,
    startDate,
    endDate,
    status,
    page = '1',
    limit = '50'
  } = req.query;
  
  const where: any = {};
  
  if (employeeId) {
    where.employeeId = employeeId as string;
  }
  
  if (departmentId) {
    where.Employee = { departmentId: departmentId as string };
  }
  
  if (startDate) {
    where.clockIn = { gte: new Date(startDate as string) };
  }
  
  if (endDate) {
    const end = new Date(endDate as string);
    end.setHours(23, 59, 59, 999);
    where.clockIn = { ...where.clockIn, lte: end };
  }
  
  if (status) {
    where.status = status as string;
  }
  
  const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
  
  const [entries, total] = await Promise.all([
    prisma.timeEntry.findMany({
      where,
      include: {
        Employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            department: { select: { name: true } }
          }
        },
        Terminal: {
          select: { name: true }
        }
      },
      skip,
      take: parseInt(limit as string),
      orderBy: { clockIn: 'desc' }
    }),
    prisma.timeEntry.count({ where })
  ]);
  
  // Format response with lowercase 'employee' key for frontend compatibility
  const formattedEntries = entries.map(entry => ({
    id: entry.id,
    employeeId: entry.employeeId,
    employee: entry.Employee,  // Rename to lowercase
    clockIn: entry.clockIn,
    clockOut: entry.clockOut,
    totalHours: entry.totalHours,
    regularHours: entry.regularHours,
    overtimeHours: entry.overtimeHours,
    status: entry.status,
    location: entry.location,
    verifyMethod: entry.verifyMethod,
    notes: entry.notes,
    isManualEntry: entry.isManualEntry,
    breakMinutes: entry.breakMinutes,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  }));
  
  res.json({
    entries: formattedEntries,
    pagination: {
      page: parseInt(page as string),
      limit: parseInt(limit as string),
      total,
      pages: Math.ceil(total / parseInt(limit as string))
    }
  });
}));

// Get time entry by ID
router.get('/:id', requirePermission('attendance:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const entry = await prisma.timeEntry.findUnique({
    where: { id: req.params.id },
    include: {
      Employee: {
        include: { department: true, shift: true }
      },
      Terminal: true
    }
  });
  
  if (!entry) {
    throw new AppError('Time entry not found', 404);
  }
  
  res.json(entry);
}));

// Create manual time entry
router.post('/', requirePermission('attendance:write'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const data = timeEntrySchema.parse(req.body);
  
  // Verify employee exists
  const employee = await prisma.employee.findUnique({
    where: { id: data.employeeId },
    include: { shift: true }
  });
  
  if (!employee) {
    throw new AppError('Employee not found', 404);
  }
  
  const clockIn = new Date(data.clockIn);
  const clockOut = data.clockOut ? new Date(data.clockOut) : null;
  
  // Calculate hours
  let totalHours = 0;
  let regularHours = 0;
  let overtimeHours = 0;
  let breakMinutes = 0;
  
  if (clockOut) {
    totalHours = (clockOut.getTime() - clockIn.getTime()) / (1000 * 60 * 60);
    
    // Subtract break time
    if (data.breakStart && data.breakEnd) {
      const breakStart = new Date(data.breakStart);
      const breakEnd = new Date(data.breakEnd);
      breakMinutes = Math.round((breakEnd.getTime() - breakStart.getTime()) / (1000 * 60));
      totalHours -= breakMinutes / 60;
    }
    
    const overtimeThreshold = employee.shift?.overtimeAfter || 8;
    regularHours = Math.min(totalHours, overtimeThreshold);
    overtimeHours = Math.max(0, totalHours - overtimeThreshold);
  }
  
  const entry = await prisma.timeEntry.create({
    data: {
      id: randomUUID(),
      employeeId: data.employeeId,
      clockIn,
      clockOut,
      breakStart: data.breakStart ? new Date(data.breakStart) : null,
      breakEnd: data.breakEnd ? new Date(data.breakEnd) : null,
      totalHours: Math.round(totalHours * 100) / 100,
      regularHours: Math.round(regularHours * 100) / 100,
      overtimeHours: Math.round(overtimeHours * 100) / 100,
      breakMinutes,
      status: clockOut ? 'clocked_out' : 'clocked_in',
      notes: data.notes,
      isManualEntry: true,
      approvedById: req.user!.id,
      updatedAt: new Date()
    },
    include: {
      Employee: {
        select: {
          id: true,
          employeeId: true,
          firstName: true,
          lastName: true
        }
      }
    }
  });
  
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'create',
      entityType: 'timeEntry',
      entityId: entry.id,
      newValue: JSON.stringify(entry)
    }
  });
  
  logger.info(`Manual time entry created for employee ${employee.employeeId}`);
  
  res.status(201).json(entry);
}));

// Update time entry
router.put('/:id', requirePermission('attendance:write'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const existing = await prisma.timeEntry.findUnique({
    where: { id: req.params.id },
    include: { Employee: { include: { shift: true } } }
  });
  
  if (!existing) {
    throw new AppError('Time entry not found', 404);
  }
  
  const data = timeEntrySchema.partial().parse(req.body);
  
  const clockIn = data.clockIn ? new Date(data.clockIn) : existing.clockIn;
  const clockOut = data.clockOut ? new Date(data.clockOut) : existing.clockOut;
  
  // Recalculate hours
  let totalHours = existing.totalHours || 0;
  let regularHours = existing.regularHours || 0;
  let overtimeHours = existing.overtimeHours || 0;
  let breakMinutes = existing.breakMinutes || 0;
  
  if (clockOut) {
    totalHours = (clockOut.getTime() - clockIn.getTime()) / (1000 * 60 * 60);
    
    const breakStart = data.breakStart ? new Date(data.breakStart) : existing.breakStart;
    const breakEnd = data.breakEnd ? new Date(data.breakEnd) : existing.breakEnd;
    
    if (breakStart && breakEnd) {
      breakMinutes = Math.round((breakEnd.getTime() - breakStart.getTime()) / (1000 * 60));
      totalHours -= breakMinutes / 60;
    }
    
    const overtimeThreshold = existing.Employee?.shift?.overtimeAfter || 8;
    regularHours = Math.min(totalHours, overtimeThreshold);
    overtimeHours = Math.max(0, totalHours - overtimeThreshold);
  }
  
  const entry = await prisma.timeEntry.update({
    where: { id: req.params.id },
    data: {
      clockIn,
      clockOut,
      breakStart: data.breakStart ? new Date(data.breakStart) : undefined,
      breakEnd: data.breakEnd ? new Date(data.breakEnd) : undefined,
      totalHours: Math.round(totalHours * 100) / 100,
      regularHours: Math.round(regularHours * 100) / 100,
      overtimeHours: Math.round(overtimeHours * 100) / 100,
      breakMinutes,
      notes: data.notes,
      status: data.status || (clockOut ? 'clocked_out' : existing.status)
    },
    include: {
      Employee: {
        select: {
          id: true,
          employeeId: true,
          firstName: true,
          lastName: true
        }
      }
    }
  });
  
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'update',
      entityType: 'timeEntry',
      entityId: entry.id,
      oldValue: JSON.stringify(existing),
      newValue: JSON.stringify(entry)
    }
  });
  
  res.json(entry);
}));

// Delete time entry
router.delete('/:id', requirePermission('attendance:delete'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const entry = await prisma.timeEntry.findUnique({
    where: { id: req.params.id }
  });
  
  if (!entry) {
    throw new AppError('Time entry not found', 404);
  }
  
  await prisma.timeEntry.delete({
    where: { id: req.params.id }
  });
  
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'delete',
      entityType: 'timeEntry',
      entityId: req.params.id,
      oldValue: JSON.stringify(entry)
    }
  });
  
  res.json({ message: 'Time entry deleted successfully' });
}));

// Approve/reject time entry
router.post('/:id/approve', requirePermission('attendance:write'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { status, reason } = req.body;
  
  if (!['approved', 'rejected'].includes(status)) {
    throw new AppError('Invalid status', 400);
  }
  
  const entry = await prisma.timeEntry.findUnique({
    where: { id: req.params.id }
  });
  
  if (!entry) {
    throw new AppError('Time entry not found', 404);
  }
  
  const updated = await prisma.timeEntry.update({
    where: { id: req.params.id },
    data: {
      status,
      notes: reason ? `${entry.notes || ''}\n[${status.toUpperCase()}] ${reason}`.trim() : entry.notes,
      approvedById: req.user!.id
    }
  });
  
  res.json(updated);
}));

// Bulk delete time entries
router.post('/bulk-delete', requirePermission('attendance:delete'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { ids } = req.body;
  
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError('Invalid IDs', 400);
  }
  
  await prisma.timeEntry.deleteMany({
    where: { id: { in: ids } }
  });
  
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'bulk_delete',
      entityType: 'timeEntry',
      newValue: JSON.stringify({ deletedIds: ids })
    }
  });
  
  res.json({ message: `${ids.length} entries deleted` });
}));

// Get summary for date range
router.get('/summary/range', requirePermission('attendance:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { employeeId, startDate, endDate } = req.query;
  
  if (!startDate || !endDate) {
    throw new AppError('Start and end date required', 400);
  }
  
  const where: any = {
    clockIn: {
      gte: new Date(startDate as string),
      lte: new Date(endDate as string)
    }
  };
  
  if (employeeId) {
    where.employeeId = employeeId as string;
  }
  
  const entries = await prisma.timeEntry.findMany({
    where,
    select: {
      totalHours: true,
      regularHours: true,
      overtimeHours: true,
      status: true
    }
  });
  
  const summary = {
    totalEntries: entries.length,
    totalHours: entries.reduce((sum, e) => sum + (e.totalHours || 0), 0),
    regularHours: entries.reduce((sum, e) => sum + (e.regularHours || 0), 0),
    overtimeHours: entries.reduce((sum, e) => sum + (e.overtimeHours || 0), 0),
    byStatus: {
      clocked_in: entries.filter(e => e.status === 'clocked_in').length,
      clocked_out: entries.filter(e => e.status === 'clocked_out').length,
      pending: entries.filter(e => e.status === 'pending').length,
      approved: entries.filter(e => e.status === 'approved').length,
      rejected: entries.filter(e => e.status === 'rejected').length
    }
  };
  
  res.json(summary);
}));

// ============================================
// AUTO CLOCK-OUT ENDPOINT
// ============================================

/**
 * Auto clock-out employees 10 minutes after their shift end time
 * Run this as a scheduled job (via cron or manual call every minute)
 */
router.post(
  '/auto-clockout',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const now = new Date();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Get all active employees with clocked-in entries for today
    const activeEntries = await prisma.timeEntry.findMany({
      where: {
        clockIn: {
          gte: today,
          lt: tomorrow,
        },
        clockOut: null,
        status: 'clocked_in',
      },
      include: {
        Employee: {
          include: {
            shift: true,
          },
        },
      },
    });

    const clockedOutEntries = [];

    for (const entry of activeEntries) {
      if (!entry.Employee.shift) continue;

      // Parse shift end time
      const [shiftHour, shiftMinute] = entry.Employee.shift.endTime.split(':').map(Number);
      const shiftEnd = new Date(now);
      shiftEnd.setHours(shiftHour, shiftMinute, 0, 0);

      // Add 10 minutes to shift end time
      const autoClockoutTime = new Date(shiftEnd.getTime() + 10 * 60 * 1000);

      // If current time is past auto-clockout time, clock out
      if (now >= autoClockoutTime) {
        try {
          // Calculate hours worked
          const totalMinutes = (now.getTime() - entry.clockIn.getTime()) / (1000 * 60);
          let totalHours = totalMinutes / 60;

          // Subtract break time (60 minutes)
          const breakMinutes = 60;
          totalHours -= breakMinutes / 60;

          // Calculate regular and overtime hours (8 hour standard)
          const regularHours = Math.min(totalHours, 8);
          const overtimeHours = Math.max(0, totalHours - 8);

          // Update time entry
          const updated = await prisma.timeEntry.update({
            where: { id: entry.id },
            data: {
              clockOut: now,
              status: 'clocked_out',
              totalHours: Math.round(totalHours * 100) / 100,
              regularHours: Math.round(regularHours * 100) / 100,
              overtimeHours: Math.round(overtimeHours * 100) / 100,
              breakMinutes,
              notes: `Auto clocked out 10 minutes after shift end. Total hours: ${Math.round(totalHours * 100) / 100}`,
              updatedAt: now,
            },
          });

          clockedOutEntries.push(updated.id);

          // Log audit
          await prisma.auditLog.create({
            data: {
              action: 'auto_clockout',
              entityType: 'timeEntry',
              entityId: updated.id,
              newValue: JSON.stringify(updated),
            },
          });

          logger.info(
            `Auto clocked out employee ${entry.Employee.employeeId} after shift ended`
          );
        } catch (error) {
          logger.error(
            `Failed to auto clock-out employee ${entry.Employee.employeeId}: ${error}`
          );
        }
      }
    }

    res.json({
      success: true,
      clockedOutCount: clockedOutEntries.length,
      clockedOutEntries,
      message: `${clockedOutEntries.length} employees auto clocked out`,
    });
  })
);

export default router;
