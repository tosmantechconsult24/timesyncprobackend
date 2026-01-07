import { Router, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuthRequest, requirePermission } from '../middleware/auth';

const router = Router();

const shiftSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional().nullable().default(''),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Start time must be HH:MM format'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'End time must be HH:MM format'),
  breakDuration: z.coerce.number().default(60),
  graceMinutes: z.coerce.number().default(15),
  overtimeAfter: z.coerce.number().default(8),
  workingDays: z.any().optional(), // Accept any format, we'll handle it
  color: z.string().optional().nullable().default('#10B981'),
  isNightShift: z.coerce.boolean().default(false),
  isActive: z.coerce.boolean().default(true)
}).passthrough(); // Allow extra fields

const shiftAssignmentSchema = z.object({
  employeeId: z.string(),
  shiftId: z.string(),
  startDate: z.string(),
  endDate: z.string().optional().nullable()
});

// Get all shifts
router.get('/', requirePermission('shifts:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const shifts = await prisma.shift.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: { employees: true }
      }
    }
  });
  
  const result = shifts.map(shift => ({
    ...shift,
    workingDays: JSON.parse(shift.workingDays),
    employeeCount: shift._count.employees
  }));
  
  res.json(result);
}));

// Get shift by ID
router.get('/:id', requirePermission('shifts:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const shift = await prisma.shift.findUnique({
    where: { id: req.params.id },
    include: {
      employees: {
        select: {
          id: true,
          employeeId: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } }
        }
      }
    }
  });
  
  if (!shift) {
    throw new AppError('Shift not found', 404);
  }
  
  res.json({
    ...shift,
    workingDays: JSON.parse(shift.workingDays)
  });
}));

// Create shift
router.post('/', requirePermission('shifts:write'), asyncHandler(async (req: AuthRequest, res: Response) => {
  // Validate and parse request body
  const parseResult = shiftSchema.safeParse(req.body);
  
  if (!parseResult.success) {
    logger.error('Shift validation error:', parseResult.error.errors);
    throw new AppError(
      `Validation error: ${parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      400
    );
  }
  
  const data = parseResult.data;
  
  // Handle workingDays - convert string to array if needed
  let workingDays = data.workingDays || [1, 2, 3, 4, 5];
  if (typeof workingDays === 'string') {
    workingDays = JSON.parse(workingDays);
  }
  
  const shift = await prisma.shift.create({
    data: {
      ...data,
      workingDays: JSON.stringify(workingDays),
      breakDuration: data.breakDuration || 60,
      graceMinutes: data.graceMinutes || 15,
      overtimeAfter: data.overtimeAfter || 8,
    },
  });
  
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'create',
      entityType: 'shift',
      entityId: shift.id,
      newValue: JSON.stringify(shift)
    }
  });
  
  res.status(201).json({
    ...shift,
    workingDays: JSON.parse(shift.workingDays)
  });
}));

// Update shift
router.put('/:id', requirePermission('shifts:write'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const existing = await prisma.shift.findUnique({
    where: { id: req.params.id }
  });
  
  if (!existing) {
    throw new AppError('Shift not found', 404);
  }
  
  const data = shiftSchema.partial().parse(req.body);
  
  // Handle workingDays - convert string to array if needed
  let workingDays: any = undefined;
  if (data.workingDays !== undefined) {
    workingDays = data.workingDays;
    if (typeof workingDays === 'string') {
      workingDays = JSON.parse(workingDays);
    }
  }
  
  const shift = await prisma.shift.update({
    where: { id: req.params.id },
    data: {
      ...data,
      workingDays: workingDays ? JSON.stringify(workingDays) : undefined,
      breakDuration: data.breakDuration || existing.breakDuration,
      graceMinutes: data.graceMinutes || existing.graceMinutes,
      overtimeAfter: data.overtimeAfter || existing.overtimeAfter,
    }
  });
  
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'update',
      entityType: 'shift',
      entityId: shift.id,
      oldValue: JSON.stringify(existing),
      newValue: JSON.stringify(shift)
    }
  });
  
  res.json({
    ...shift,
    workingDays: JSON.parse(shift.workingDays)
  });
}));

// Delete shift
router.delete('/:id', requirePermission('shifts:delete'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const shift = await prisma.shift.findUnique({
    where: { id: req.params.id },
    include: {
      _count: { select: { employees: true } }
    }
  });
  
  if (!shift) {
    throw new AppError('Shift not found', 404);
  }
  
  // Remove shift assignment from employees
  if (shift._count.employees > 0) {
    await prisma.employee.updateMany({
      where: { shiftId: req.params.id },
      data: { shiftId: null }
    });
  }
  
  // Delete shift assignments
  await prisma.shiftAssignment.deleteMany({
    where: { shiftId: req.params.id }
  });
  
  await prisma.shift.delete({
    where: { id: req.params.id }
  });
  
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'delete',
      entityType: 'shift',
      entityId: req.params.id,
      oldValue: JSON.stringify(shift)
    }
  });
  
  res.json({ message: 'Shift deleted successfully' });
}));

// Assign employees to shift
router.post('/assign', requirePermission('shifts:write'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { employeeIds, shiftId, startDate, endDate } = req.body;
  
  if (!Array.isArray(employeeIds) || !shiftId) {
    throw new AppError('Invalid data', 400);
  }
  
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId }
  });
  
  if (!shift) {
    throw new AppError('Shift not found', 404);
  }
  
  // Update employees' default shift
  await prisma.employee.updateMany({
    where: { id: { in: employeeIds } },
    data: { shiftId }
  });
  
  // Create shift assignments for tracking
  const assignments = employeeIds.map((employeeId, idx) => ({
    id: randomUUID(),
    employeeId,
    shiftId,
    startDate: startDate ? new Date(startDate) : new Date(),
    endDate: endDate ? new Date(endDate) : null,
    assignedById: req.user!.id
  }));
  
  await prisma.shiftAssignment.createMany({
    data: assignments
  });
  
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'assign',
      entityType: 'shiftAssignment',
      entityId: shiftId,
      newValue: JSON.stringify({ employeeIds, shiftId })
    }
  });
  
  res.json({ message: `${employeeIds.length} employees assigned to shift` });
}));

// Get shift schedule (weekly view)
router.get('/schedule/weekly', requirePermission('shifts:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { startDate } = req.query;
  
  const start = startDate ? new Date(startDate as string) : new Date();
  start.setHours(0, 0, 0, 0);
  
  // Get start of week (Monday)
  const dayOfWeek = start.getDay();
  const diff = start.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  const weekStart = new Date(start.setDate(diff));
  
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  
  const [shifts, employees, assignments] = await Promise.all([
    prisma.shift.findMany({ where: { isActive: true } }),
    prisma.employee.findMany({
      where: { status: 'active' },
      include: {
        shift: true,
        department: { select: { name: true } }
      }
    }),
    prisma.shiftAssignment.findMany({
      where: {
        isActive: true,
        startDate: { lte: weekEnd },
        OR: [
          { endDate: null },
          { endDate: { gte: weekStart } }
        ]
      }
    })
  ]);
  
  // Build schedule
  const schedule: any[] = [];
  
  for (let i = 0; i < 7; i++) {
    const date = new Date(weekStart);
    date.setDate(date.getDate() + i);
    const dayNumber = date.getDay();
    
    const daySchedule: any = {
      date: date.toISOString().split('T')[0],
      dayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayNumber],
      shifts: []
    };
    
    for (const shift of shifts) {
      const workingDays = JSON.parse(shift.workingDays);
      
      if (workingDays.includes(dayNumber)) {
        const shiftEmployees = employees.filter(emp => {
          // Check if employee has this shift assigned
          return emp.shiftId === shift.id;
        });
        
        daySchedule.shifts.push({
          shift: {
            id: shift.id,
            name: shift.name,
            startTime: shift.startTime,
            endTime: shift.endTime,
            color: shift.color
          },
          employees: shiftEmployees.map(emp => ({
            id: emp.id,
            employeeId: emp.employeeId,
            name: `${emp.firstName} ${emp.lastName}`,
            department: emp.department?.name
          }))
        });
      }
    }
    
    schedule.push(daySchedule);
  }
  
  res.json(schedule);
}));

// Get employees not assigned to any shift
router.get('/unassigned', requirePermission('shifts:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const employees = await prisma.employee.findMany({
    where: {
      status: 'active',
      shiftId: null
    },
    select: {
      id: true,
      employeeId: true,
      firstName: true,
      lastName: true,
      department: { select: { name: true } }
    }
  });
  
  res.json(employees);
}));

export default router;
