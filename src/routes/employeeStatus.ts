/**
 * routes/employeeStatus.ts - Employee Status Management
 * Handles suspension, inactivation, and status tracking
 * Only admin/manager authorized
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuthRequest, authMiddleware, requireRole } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();

// Validation schemas
const suspendEmployeeSchema = z.object({
  employeeId: z.string().min(1),
  reason: z.enum(['suspended', 'resigned', 'sacked', 'retired', 'other']),
  details: z.string().optional(),
});

const reactivateEmployeeSchema = z.object({
  employeeId: z.string().min(1),
  notes: z.string().optional(),
});

// ============================================
// SUSPEND/INACTIVATE EMPLOYEE
// ============================================

/**
 * Suspend or mark employee as inactive
 * Protected: requires admin role
 */
router.post(
  '/suspend',
  authMiddleware,
  requireRole('admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId, reason, details } =
      suspendEmployeeSchema.parse(req.body);

    // Get employee
    const employee = await prisma.employee.findUnique({
      where: { employeeId },
      select: {
        id: true,
        employeeId: true,
        firstName: true,
        lastName: true,
        departmentId: true,
        status: true,
      },
    });

    if (!employee) {
      throw new AppError('Employee not found', 404);
    }

    if (employee.status !== 'active') {
      throw new AppError(
        'Employee is already inactive. Cannot suspend.',
        400
      );
    }

    // Update employee status
    const updated = await prisma.employee.update({
      where: { employeeId },
      data: {
        status: 'inactive',
        updatedAt: new Date(),
      },
      select: {
        id: true,
        employeeId: true,
        firstName: true,
        lastName: true,
        status: true,
      },
    });

    // Create inactive employee record
    const inactiveRecord = await prisma.inactiveEmployee.create({
      data: {
        employeeId,
        employeeName: `${employee.firstName} ${employee.lastName}`,
        departmentId: employee.departmentId || undefined,
        inactiveReason: reason,
        details: details || undefined,
        suspendedBy: req.user!.id,
        suspendedAt: new Date(),
      },
    });

    // Clock out if employee is currently clocked in
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
        clockOut: null,
      },
    });

    if (activeEntry) {
      const now = new Date();
      await prisma.timeEntry.update({
        where: { id: activeEntry.id },
        data: {
          clockOut: now,
          status: 'clocked_out',
          notes: `Auto clock-out due to employee suspension at ${now.toISOString()}`,
        },
      });
    }

    // Log audit
    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'suspend_employee',
        entityType: 'employee',
        entityId: employee.id,
        newValue: JSON.stringify({
          status: updated.status,
          reason,
          details,
        }),
      },
    });

    logger.warn(
      `Employee ${employeeId} suspended by ${req.user!.email}. Reason: ${reason}`
    );

    res.json({
      success: true,
      employee: updated,
      inactiveRecord,
      message: `Employee ${employee.firstName} ${employee.lastName} has been suspended.`,
    });
  })
);

/**
 * Reactivate employee
 * Protected: requires admin role
 */
router.post(
  '/reactivate',
  authMiddleware,
  requireRole('admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId, notes } = reactivateEmployeeSchema.parse(req.body);

    // Get employee
    const employee = await prisma.employee.findUnique({
      where: { employeeId },
      select: {
        id: true,
        employeeId: true,
        firstName: true,
        lastName: true,
        status: true,
      },
    });

    if (!employee) {
      throw new AppError('Employee not found', 404);
    }

    if (employee.status === 'active') {
      throw new AppError('Employee is already active.', 400);
    }

    // Update employee status
    const updated = await prisma.employee.update({
      where: { employeeId },
      data: {
        status: 'active',
        updatedAt: new Date(),
      },
      select: {
        id: true,
        employeeId: true,
        firstName: true,
        lastName: true,
        status: true,
      },
    });

    // Update inactive employee record
    await prisma.inactiveEmployee.updateMany({
      where: { employeeId },
      data: {
        reactivatedAt: new Date(),
        reactivatedBy: req.user!.id,
        notes,
      },
    });

    // Log audit
    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'reactivate_employee',
        entityType: 'employee',
        entityId: employee.id,
        newValue: JSON.stringify({
          status: updated.status,
          reactivatedAt: new Date(),
        }),
      },
    });

    logger.info(
      `Employee ${employeeId} reactivated by ${req.user!.email}`
    );

    res.json({
      success: true,
      employee: updated,
      message: `Employee ${employee.firstName} ${employee.lastName} has been reactivated.`,
    });
  })
);

// ============================================
// GET INACTIVE EMPLOYEES
// ============================================

/**
 * Get all inactive employees with their suspension records
 * Protected: requires admin role
 */
router.get(
  '/inactive',
  authMiddleware,
  requireRole('admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { departmentId, reason, limit = '50', offset = '0' } = req.query;

    const where: any = {};

    if (departmentId) {
      where.departmentId = departmentId as string;
    }

    if (reason) {
      where.inactiveReason = reason as string;
    }

    const [inactiveRecords, total] = await Promise.all([
      prisma.inactiveEmployee.findMany({
        where,
        orderBy: { suspendedAt: 'desc' },
        take: parseInt(limit as string),
        skip: parseInt(offset as string),
      }),
      prisma.inactiveEmployee.count({ where }),
    ]);

    res.json({
      data: inactiveRecords,
      pagination: {
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
        total,
      },
    });
  })
);

/**
 * Get inactive employee details
 * Protected: requires admin role
 */
router.get(
  '/inactive/:employeeId',
  authMiddleware,
  requireRole('admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId } = req.params;

    const record = await prisma.inactiveEmployee.findUnique({
      where: { employeeId },
    });

    if (!record) {
      throw new AppError('No inactivity record found for this employee', 404);
    }

    res.json(record);
  })
);

// ============================================
// GET EMPLOYEE STATUS
// ============================================

/**
 * Get employee status information
 * Used by kiosk to check if employee can clock in
 */
router.get(
  '/check/:employeeId',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId } = req.params;

    const employee = await prisma.employee.findUnique({
      where: { employeeId },
      select: {
        id: true,
        employeeId: true,
        firstName: true,
        lastName: true,
        status: true,
        department: { select: { name: true } },
        shift: { select: { name: true, startTime: true, endTime: true } },
      },
    });

    if (!employee) {
      throw new AppError('Employee not found', 404);
    }

    const inactiveRecord = await prisma.inactiveEmployee.findUnique({
      where: { employeeId },
      select: {
        inactiveReason: true,
        details: true,
        suspendedAt: true,
      },
    });

    res.json({
      employee: {
        id: employee.id,
        employeeId: employee.employeeId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        status: employee.status,
        department: employee.department?.name,
        shift: employee.shift,
      },
      isActive: employee.status === 'active',
      inactive: inactiveRecord,
    });
  })
);

// ============================================
// SUSPEND MANAGER (Super Admin Only)
// ============================================

/**
 * Suspend a department manager
 * Protected: requires super-admin role
 */
router.post(
  '/suspend-manager',
  authMiddleware,
  requireRole('super_admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { userId, reason, details } = z
      .object({
        userId: z.string().min(1),
        reason: z.string(),
        details: z.string().optional(),
      })
      .parse(req.body);

    // Get user
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    if (user.role !== 'manager') {
      throw new AppError('User is not a manager', 400);
    }

    // Deactivate user account
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        isActive: false,
        updatedAt: new Date(),
      },
    });

    // Find associated employee and mark as inactive
    const employee = await prisma.employee.findUnique({
      where: { userId },
    });

    if (employee) {
      await prisma.employee.update({
        where: { id: employee.id },
        data: { status: 'inactive' },
      });

      await prisma.inactiveEmployee.create({
        data: {
          employeeId: employee.employeeId,
          employeeName: `${employee.firstName} ${employee.lastName}`,
          departmentId: employee.departmentId || undefined,
          inactiveReason: 'suspended',
          details: `Manager suspended: ${reason}${details ? ` - ${details}` : ''}`,
          suspendedBy: req.user!.id,
        },
      });
    }

    // Log audit
    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'suspend_manager',
        entityType: 'user',
        entityId: userId,
        newValue: JSON.stringify({ isActive: false, reason }),
      },
    });

    logger.warn(
      `Manager ${user.email} suspended by ${req.user!.email}. Reason: ${reason}`
    );

    res.json({
      success: true,
      user: {
        id: updated.id,
        email: updated.email,
        isActive: updated.isActive,
      },
      message: `Manager ${user.email} has been suspended.`,
    });
  })
);

/**
 * Get all active employees
 */
router.get(
  '/active',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { departmentId, limit = '100', offset = '0' } = req.query;

    const where: any = {
      status: 'active',
    };

    if (departmentId) {
      where.departmentId = departmentId as string;
    }

    const [employees, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        include: {
          department: { select: { name: true } },
          shift: { select: { name: true } },
        },
        orderBy: { employeeId: 'asc' },
        take: parseInt(limit as string),
        skip: parseInt(offset as string),
      }),
      prisma.employee.count({ where }),
    ]);

    res.json({
      data: employees,
      pagination: {
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
        total,
      },
    });
  })
);

export default router;
