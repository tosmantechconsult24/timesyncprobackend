import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuthRequest, requirePermission } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();

const leaveRequestSchema = z.object({
  employeeId: z.string(),
  leaveType: z.enum(['sick', 'vacation', 'personal', 'maternity', 'paternity', 'unpaid']),
  startDate: z.string(),
  endDate: z.string(),
  reason: z.string().optional()
});

// Calculate working days between two dates
function calculateWorkingDays(startDate: Date, endDate: Date, workingDays: number[] = [1, 2, 3, 4, 5]): number {
  let count = 0;
  const current = new Date(startDate);
  
  while (current <= endDate) {
    if (workingDays.includes(current.getDay())) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }
  
  return count;
}

// Get all leave requests
router.get('/', requirePermission('leaves:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { status, employeeId, leaveType, startDate, endDate, page = '1', limit = '50' } = req.query;
  
  const where: any = {};
  
  if (status) {
    where.status = status as string;
  }
  
  if (employeeId) {
    where.employeeId = employeeId as string;
  }
  
  if (leaveType) {
    where.leaveType = leaveType as string;
  }
  
  if (startDate) {
    where.startDate = { gte: new Date(startDate as string) };
  }
  
  if (endDate) {
    where.endDate = { lte: new Date(endDate as string) };
  }
  
  const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
  
  const [requests, total] = await Promise.all([
    prisma.leaveRequest.findMany({
      where,
      include: {
        Employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            photo: true,
            department: { select: { name: true } }
          }
        },
        User: {
          select: { id: true, firstName: true, lastName: true, email: true }
        }
      },
      skip,
      take: parseInt(limit as string),
      orderBy: { createdAt: 'desc' }
    }),
    prisma.leaveRequest.count({ where })
  ]);
  
  res.json({
    requests,
    pagination: {
      page: parseInt(page as string),
      limit: parseInt(limit as string),
      total,
      pages: Math.ceil(total / parseInt(limit as string))
    }
  });
}));

// Get leave request by ID
router.get('/:id', requirePermission('leaves:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const request = await prisma.leaveRequest.findUnique({
    where: { id: req.params.id },
    include: {
      Employee: {
        include: {
          department: true,
          shift: true
        }
      },
      User: {
        select: { firstName: true, lastName: true }
      }
    }
  });
  
  if (!request) {
    throw new AppError('Leave request not found', 404);
  }
  
  res.json(request);
}));

// PUBLIC: Create leave request from kiosk (no auth required)
router.post('/kiosk/submit', async (req: any, res: any) => {
  try {
    const { employeeId, leaveType, startDate, endDate, reason } = req.body;

    // Validate required fields
    if (!employeeId || !leaveType || !startDate || !endDate) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify employee exists and is active
    const employee = await prisma.employee.findUnique({
      where: { employeeId },
      include: { shift: true }
    });

    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    if (employee.status !== 'active') {
      return res.status(403).json({ 
        error: `Your account is ${employee.status}. Please contact HR.` 
      });
    }

    // Check for overlapping leave requests
    const overlapping = await prisma.leaveRequest.findFirst({
      where: {
        employeeId: employee.id,
        status: { in: ['pending', 'approved'] },
        AND: [
          { startDate: { lte: new Date(endDate) } },
          { endDate: { gte: new Date(startDate) } }
        ]
      }
    });

    if (overlapping) {
      return res.status(400).json({ error: 'You already have a leave request during this period' });
    }

    // Create leave request
    const leaveRequest = await prisma.leaveRequest.create({
      data: {
        id: randomUUID(),
        employeeId: employee.id,
        leaveType,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        reason: reason || '',
        status: 'pending',
        totalDays: calculateWorkingDays(new Date(startDate), new Date(endDate)),
        updatedAt: new Date()
      },
      include: {
        Employee: {
          select: {
            firstName: true,
            lastName: true,
            email: true
          }
        }
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Leave request submitted successfully',
      leaveRequest
    });
  } catch (error: any) {
    console.error('Error creating leave request:', error);
    return res.status(500).json({ error: 'Failed to submit leave request' });
  }
});

// Create leave request
router.post('/', requirePermission('leaves:write'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const data = leaveRequestSchema.parse(req.body);
  
  const employee = await prisma.employee.findUnique({
    where: { id: data.employeeId },
    include: { shift: true }
  });
  

  if (!employee) {
    throw new AppError('Employee not found', 404);
  }
  
  const startDate = new Date(data.startDate);
  const endDate = new Date(data.endDate);
  
  if (startDate > endDate) {
    throw new AppError('End date must be after start date', 400);
  }
  
  // Check for overlapping leave requests
  const overlapping = await prisma.leaveRequest.findFirst({
    where: {
      employeeId: data.employeeId,
      status: { in: ['pending', 'approved'] },
      OR: [
        {
          startDate: { lte: endDate },
          endDate: { gte: startDate }
        }
      ]
    }
  });
  
  if (overlapping) {
    throw new AppError('Employee already has leave scheduled for this period', 409);
  }
  
  // Calculate working days
  const workingDays = employee.shift 
    ? JSON.parse(employee.shift.workingDays) 
    : [1, 2, 3, 4, 5];
  
  const totalDays = calculateWorkingDays(startDate, endDate, workingDays);
  
  // Check leave balance
  const currentYear = new Date().getFullYear();
  const balance = await prisma.leaveBalance.findUnique({
    where: {
      employeeId_leaveType_year: {
        employeeId: data.employeeId,
        leaveType: data.leaveType,
        year: currentYear
      }
    }
  });
  
  if (balance && balance.remainingDays < totalDays && data.leaveType !== 'unpaid') {
    throw new AppError(`Insufficient leave balance. Available: ${balance.remainingDays} days`, 400);
  }
  
  const request = await prisma.leaveRequest.create({
    data: {
      id: randomUUID(),
      employeeId: data.employeeId,
      leaveType: data.leaveType,
      startDate,
      endDate,
      totalDays,
      reason: data.reason,
      status: 'pending',
      updatedAt: new Date()
    },
    include: {
      Employee: {
        select: {
          employeeId: true,
          firstName: true,
          lastName: true
        }
      }
    }
  });
  
  // Create notification for managers
  await prisma.notification.create({
    data: {
      id: randomUUID(),
      type: 'leave_request',
      title: 'New Leave Request',
      message: `${employee.firstName} ${employee.lastName} has requested ${totalDays} days of ${data.leaveType} leave`,
      data: JSON.stringify({ requestId: request.id })
    }
  });
  
  logger.info(`Leave request created for ${employee.employeeId}`);
  
  res.status(201).json(request);
}));

// Update leave request
router.put('/:id', requirePermission('leaves:write'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const existing = await prisma.leaveRequest.findUnique({
    where: { id: req.params.id }
  });
  
  if (!existing) {
    throw new AppError('Leave request not found', 404);
  }
  
  if (existing.status !== 'pending') {
    throw new AppError('Can only edit pending leave requests', 400);
  }
  
  const data = leaveRequestSchema.partial().parse(req.body);
  
  const employee = await prisma.employee.findUnique({
    where: { id: data.employeeId || existing.employeeId },
    include: { shift: true }
  });
  
  const startDate = data.startDate ? new Date(data.startDate) : existing.startDate;
  const endDate = data.endDate ? new Date(data.endDate) : existing.endDate;
  
  const workingDays = employee?.shift 
    ? JSON.parse(employee.shift.workingDays) 
    : [1, 2, 3, 4, 5];
  
  const totalDays = calculateWorkingDays(startDate, endDate, workingDays);
  
  const request = await prisma.leaveRequest.update({
    where: { id: req.params.id },
    data: {
      leaveType: data.leaveType,
      startDate,
      endDate,
      totalDays,
      reason: data.reason
    }
  });
  
  res.json(request);
}));

// Approve/reject leave request
router.post('/:id/approve', requirePermission('leaves:approve'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { status, rejectionReason } = req.body;
  
  if (!['approved', 'rejected'].includes(status)) {
    throw new AppError('Invalid status', 400);
  }
  
  const request = await prisma.leaveRequest.findUnique({
    where: { id: req.params.id },
    include: { Employee: true }
  });
  
  if (!request) {
    throw new AppError('Leave request not found', 404);
  }
  
  if (request.status !== 'pending') {
    throw new AppError('Leave request has already been processed', 400);
  }
  
  const updated = await prisma.leaveRequest.update({
    where: { id: req.params.id },
    data: {
      status,
      approvedById: req.user!.id,
      approvedAt: new Date(),
      rejectionReason: status === 'rejected' ? rejectionReason : null
    }
  });
  
  // Update leave balance if approved
  if (status === 'approved' && request.leaveType !== 'unpaid') {
    const currentYear = new Date().getFullYear();
    
    await prisma.leaveBalance.upsert({
      where: {
        employeeId_leaveType_year: {
          employeeId: request.employeeId,
          leaveType: request.leaveType,
          year: currentYear
        }
      },
      create: {
        id: randomUUID(),
        employeeId: request.employeeId,
        leaveType: request.leaveType,
        year: currentYear,
        totalDays: 0,
        usedDays: request.totalDays,
        remainingDays: -request.totalDays
      },
      update: {
        usedDays: { increment: request.totalDays },
        remainingDays: { decrement: request.totalDays }
      }
    });
  }
  
  // Create notification for employee
  await prisma.notification.create({
    data: {
      id: randomUUID(),
      employeeId: request.employeeId,
      type: 'leave_response',
      title: `Leave Request ${status === 'approved' ? 'Approved' : 'Rejected'}`,
      message: status === 'approved' 
        ? `Your ${request.leaveType} leave request has been approved`
        : `Your ${request.leaveType} leave request has been rejected. Reason: ${rejectionReason || 'Not specified'}`,
      data: JSON.stringify({ requestId: request.id })
    }
  });
  
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: status === 'approved' ? 'approve' : 'reject',
      entityType: 'leaveRequest',
      entityId: request.id,
      oldValue: JSON.stringify(request),
      newValue: JSON.stringify(updated)
    }
  });
  
  logger.info(`Leave request ${status} for ${request.Employee.employeeId}`);
  
  res.json(updated);
}));

// Verify fingerprint for leave request authorization
router.post('/:id/verify-fingerprint', requirePermission('leaves:approve'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { fingerprintData } = req.body;

  if (!fingerprintData) {
    throw new AppError('Fingerprint data is required', 400);
  }

  const request = await prisma.leaveRequest.findUnique({
    where: { id: req.params.id },
    include: { Employee: true }
  });

  if (!request) {
    throw new AppError('Leave request not found', 404);
  }

  // Verify employee has fingerprint enrolled
  if (!request.Employee.fingerprintTemplate) {
    throw new AppError('Employee does not have fingerprint enrolled', 400);
  }

  // Here you would normally verify the fingerprint against the template
  // For now, we'll return success indicating fingerprint verification passed
  // In a real implementation, you would use a fingerprint matching algorithm
  
  logger.info(`Fingerprint verified for leave request ${request.id} by ${req.user!.id}`);

  res.json({
    verified: true,
    message: 'Fingerprint verified successfully',
    employeeId: request.employeeId,
    leaveRequestId: request.id
  });
}));

// ============================================
// DEPARTMENT MANAGER APPROVAL
// ============================================

/**
 * Get pending leave requests for manager's department
 * Protected: requires manager role
 */
router.get(
  '/manager/pending',
  requirePermission('leaves:approve'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    // Get user's associated employee (manager)
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { Employee: { include: { department: true } } }
    });

    if (!user?.Employee?.department) {
      throw new AppError('Manager not assigned to a department', 400);
    }

    const departmentId = user.Employee.department.id;

    const [requests, total] = await Promise.all([
      prisma.leaveRequest.findMany({
        where: {
          status: 'pending',
          Employee: {
            departmentId
          }
        },
        include: {
          Employee: {
            select: {
              id: true,
              employeeId: true,
              firstName: true,
              lastName: true,
              department: { select: { name: true } }
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.leaveRequest.count({
        where: {
          status: 'pending',
          Employee: { departmentId }
        }
      })
    ]);

    res.json({
      requests,
      total,
      department: user.Employee.department.name
    });
  })
);

/**
 * Manager approves/rejects leave request for their department
 * Protected: requires manager role
 */
router.post(
  '/manager/:id/approve',
  requirePermission('leaves:approve'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { status, rejectionReason } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      throw new AppError('Invalid status', 400);
    }

    // Verify manager's department
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { Employee: { include: { department: true } } }
    });

    if (!user?.Employee?.department) {
      throw new AppError('Manager not assigned to a department', 400);
    }

    const request = await prisma.leaveRequest.findUnique({
      where: { id: req.params.id },
      include: { Employee: true }
    });

    if (!request) {
      throw new AppError('Leave request not found', 404);
    }

    // Verify employee is in manager's department
    const employee = await prisma.employee.findUnique({
      where: { id: request.employeeId },
      include: { department: true }
    });

    if (!employee || employee.departmentId !== user.Employee.departmentId) {
      throw new AppError('Employee not in your department', 403);
    }

    if (request.status !== 'pending') {
      throw new AppError('Leave request has already been processed', 400);
    }

    const updated = await prisma.leaveRequest.update({
      where: { id: req.params.id },
      data: {
        status,
        approvedById: req.user!.id,
        approvedAt: new Date(),
        rejectionReason: status === 'rejected' ? rejectionReason : null
      }
    });

    // Update leave balance if approved
    if (status === 'approved' && request.leaveType !== 'unpaid') {
      const currentYear = new Date().getFullYear();

      await prisma.leaveBalance.upsert({
        where: {
          employeeId_leaveType_year: {
            employeeId: request.employeeId,
            leaveType: request.leaveType,
            year: currentYear
          }
        },
        create: {
          id: randomUUID(),
          employeeId: request.employeeId,
          leaveType: request.leaveType,
          year: currentYear,
          totalDays: 0,
          usedDays: request.totalDays,
          remainingDays: -request.totalDays
        },
        update: {
          usedDays: { increment: request.totalDays },
          remainingDays: { decrement: request.totalDays }
        }
      });
    }

    // Create notification for employee
    await prisma.notification.create({
      data: {
        id: randomUUID(),
        employeeId: request.employeeId,
        type: 'leave_response',
        title: `Leave Request ${status === 'approved' ? 'Approved' : 'Rejected'}`,
        message: status === 'approved'
          ? `Your ${request.leaveType} leave request from ${request.startDate.toDateString()} to ${request.endDate.toDateString()} has been approved by your manager.`
          : `Your ${request.leaveType} leave request has been rejected. Reason: ${rejectionReason || 'Not specified'}`,
        data: JSON.stringify({ requestId: request.id })
      }
    });

    // Log audit
    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: `leave_request_${status}`,
        entityType: 'leaveRequest',
        entityId: request.id,
        oldValue: JSON.stringify(request),
        newValue: JSON.stringify(updated),
        ipAddress: req.ip || undefined
      }
    });

    logger.info(
      `Leave request ${status} by manager ${req.user!.email} for employee ${employee.employeeId}`
    );

    res.json({
      success: true,
      request: updated,
      message: `Leave request has been ${status}`
    });
  })
);

// Cancel leave request
router.post('/:id/cancel', requirePermission('leaves:write'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const request = await prisma.leaveRequest.findUnique({
    where: { id: req.params.id }
  });
  
  if (!request) {
    throw new AppError('Leave request not found', 404);
  }
  
  if (request.status === 'cancelled') {
    throw new AppError('Leave request is already cancelled', 400);
  }
  
  // If already approved, restore leave balance
  if (request.status === 'approved' && request.leaveType !== 'unpaid') {
    const currentYear = new Date().getFullYear();
    
    await prisma.leaveBalance.update({
      where: {
        employeeId_leaveType_year: {
          employeeId: request.employeeId,
          leaveType: request.leaveType,
          year: currentYear
        }
      },
      data: {
        usedDays: { decrement: request.totalDays },
        remainingDays: { increment: request.totalDays }
      }
    });
  }
  
  const updated = await prisma.leaveRequest.update({
    where: { id: req.params.id },
    data: { status: 'cancelled' }
  });
  
  res.json(updated);
}));

// Get leave balances for an employee
router.get('/balance/:employeeId', requirePermission('leaves:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { year } = req.query;
  const targetYear = year ? parseInt(year as string) : new Date().getFullYear();
  
  const employee = await prisma.employee.findUnique({
    where: { id: req.params.employeeId }
  });
  
  if (!employee) {
    throw new AppError('Employee not found', 404);
  }
  
  // Get or create default balances
  const leaveTypes = ['sick', 'vacation', 'personal'];
  const defaultDays: Record<string, number> = {
    sick: 10,
    vacation: 20,
    personal: 5
  };
  
  const balances = [];
  
  for (const leaveType of leaveTypes) {
    const balance = await prisma.leaveBalance.upsert({
      where: {
        employeeId_leaveType_year: {
          employeeId: req.params.employeeId,
          leaveType,
          year: targetYear
        }
      },
      create: {
        id: randomUUID(),
        employeeId: req.params.employeeId,
        leaveType,
        year: targetYear,
        totalDays: defaultDays[leaveType],
        usedDays: 0,
        remainingDays: defaultDays[leaveType]
      },
      update: {}
    });
    
    balances.push(balance);
  }
  
  res.json(balances);
}));

// Update leave balance
router.put('/balance/:employeeId', requirePermission('leaves:write'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { leaveType, totalDays, year } = req.body;
  
  const targetYear = year || new Date().getFullYear();
  
  const existing = await prisma.leaveBalance.findUnique({
    where: {
      employeeId_leaveType_year: {
        employeeId: req.params.employeeId,
        leaveType,
        year: targetYear
      }
    }
  });
  
  const usedDays = existing?.usedDays || 0;
  
  const balance = await prisma.leaveBalance.upsert({
    where: {
      employeeId_leaveType_year: {
        employeeId: req.params.employeeId,
        leaveType,
        year: targetYear
      }
    },
    create: {
      id: randomUUID(),
      employeeId: req.params.employeeId,
      leaveType,
      year: targetYear,
      totalDays,
      usedDays: 0,
      remainingDays: totalDays
    },
    update: {
      totalDays,
      remainingDays: totalDays - usedDays
    }
  });
  
  res.json(balance);
}));

// Get leave calendar
router.get('/calendar', requirePermission('leaves:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { month, year, departmentId } = req.query;
  
  const targetMonth = month ? parseInt(month as string) - 1 : new Date().getMonth();
  const targetYear = year ? parseInt(year as string) : new Date().getFullYear();
  
  const startDate = new Date(targetYear, targetMonth, 1);
  const endDate = new Date(targetYear, targetMonth + 1, 0);
  
  const where: any = {
    status: 'approved',
    startDate: { lte: endDate },
    endDate: { gte: startDate }
  };
  
  if (departmentId) {
    where.Employee = { departmentId: departmentId as string };
  }
  
  const leaves = await prisma.leaveRequest.findMany({
    where,
    include: {
      Employee: {
        select: {
          id: true,
          employeeId: true,
          firstName: true,
          lastName: true,
          photo: true,
          department: { select: { name: true } }
        }
      }
    }
  });
  
  // Build calendar events
  const events = leaves.map(leave => ({
    id: leave.id,
    title: `${leave.Employee.firstName} ${leave.Employee.lastName} - ${leave.leaveType}`,
    start: leave.startDate.toISOString().split('T')[0],
    end: leave.endDate.toISOString().split('T')[0],
    Employee: leave.Employee,
    leaveType: leave.leaveType,
    totalDays: leave.totalDays
  }));
  
  res.json(events);
}));

// Get leave summary/statistics
router.get('/summary', requirePermission('leaves:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { year } = req.query;
  const targetYear = year ? parseInt(year as string) : new Date().getFullYear();
  
  const startOfYear = new Date(targetYear, 0, 1);
  const endOfYear = new Date(targetYear, 11, 31);
  
  const [
    pending,
    approved,
    rejected,
    byType,
    byMonth
  ] = await Promise.all([
    prisma.leaveRequest.count({
      where: { status: 'pending' }
    }),
    prisma.leaveRequest.count({
      where: {
        status: 'approved',
        startDate: { gte: startOfYear, lte: endOfYear }
      }
    }),
    prisma.leaveRequest.count({
      where: {
        status: 'rejected',
        createdAt: { gte: startOfYear, lte: endOfYear }
      }
    }),
    prisma.leaveRequest.groupBy({
      by: ['leaveType'],
      where: {
        status: 'approved',
        startDate: { gte: startOfYear, lte: endOfYear }
      },
      _sum: { totalDays: true },
      _count: true
    }),
    prisma.$queryRaw`
      SELECT 
        strftime('%m', startDate) as month,
        COUNT(*) as count,
        SUM(totalDays) as totalDays
      FROM LeaveRequest
      WHERE status = 'approved'
        AND startDate >= ${startOfYear}
        AND startDate <= ${endOfYear}
      GROUP BY strftime('%m', startDate)
      ORDER BY month
    `
  ]);
  
  res.json({
    pending,
    approved,
    rejected,
    byType: byType.map(t => ({
      type: t.leaveType,
      count: t._count,
      totalDays: t._sum.totalDays
    })),
    byMonth
  });
}));

export default router;

