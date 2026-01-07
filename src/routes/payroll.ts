// ============================================
// routes/payroll.ts - Payroll Management
// ============================================
import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuthRequest, requireRole } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();

// ============================================
// SCHEMAS
// ============================================
const EmployeeRateSchema = z.object({
  hourlyRate: z.number().optional(),
  dailyRate: z.number().optional(),
  salary: z.number().optional(),
  overtimeRate: z.number().optional(),
  rateType: z.enum(['hourly', 'daily', 'salary']).optional(),
  notes: z.string().optional(),
});

const DeductionCreateSchema = z.object({
  employeeId: z.string(),
  deductionType: z.string(),
  amount: z.number().positive(),
  reason: z.string(),
  description: z.string().optional(),
  month: z.string().pipe(z.coerce.date()),
});

const InfractionCreateSchema = z.object({
  employeeId: z.string(),
  type: z.string(),
  severity: z.enum(['minor', 'moderate', 'major']).optional().default('minor'),
  amount: z.number().min(0).optional(),
  description: z.string(),
  date: z.string().pipe(z.coerce.date()),
});

// ============================================
// EMPLOYEE RATES MANAGEMENT
// ============================================

// Get employee rate
router.get(
  '/rates/:employeeId',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId } = z.object({ employeeId: z.string() }).parse(req.params);

    const employeeRate = await prisma.employeeRate.findUnique({
      where: { employeeId },
      include: {
        Employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            designation: true,
            department: { select: { name: true } },
          },
        },
      },
    });

    if (!employeeRate) {
      throw new AppError('Employee rate not found', 404);
    }

    res.json(employeeRate);
  })
);

// Create or update employee rate
router.put(
  '/rates/:employeeId',
  requireRole('super_admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId } = z.object({ employeeId: z.string() }).parse(req.params);
    const body = EmployeeRateSchema.parse(req.body);

    // Validate employee exists
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new AppError('Employee not found', 404);
    }

    const employeeRate = await prisma.employeeRate.upsert({
      where: { employeeId },
      create: {
        employeeId,
        hourlyRate: body.hourlyRate ?? 0,
        dailyRate: body.dailyRate,
        salary: body.salary,
        overtimeRate:
          body.overtimeRate ?? (body.hourlyRate ? body.hourlyRate * 1.5 : undefined),
        rateType: body.rateType ?? 'hourly',
        notes: body.notes,
      },
      update: {
        hourlyRate: body.hourlyRate,
        dailyRate: body.dailyRate,
        salary: body.salary,
        overtimeRate: body.overtimeRate,
        rateType: body.rateType,
        notes: body.notes,
        updatedAt: new Date(),
      },
      include: {
        Employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            designation: true,
          },
        },
      },
    });

    // Log audit
    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'UPDATE_EMPLOYEE_RATE',
        entityType: 'EmployeeRate',
        entityId: employeeRate.id,
        newValue: JSON.stringify({
          hourlyRate: employeeRate.hourlyRate,
          overtimeRate: employeeRate.overtimeRate,
          rateType: employeeRate.rateType,
        }),
      },
    });

    res.json(employeeRate);
  })
);

// Get all employee rates (optionally filtered by department)
router.get(
  '/rates',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { departmentId } = z
      .object({ departmentId: z.string().optional() })
      .parse(req.query);

    const rates = await prisma.employeeRate.findMany({
      where: departmentId
        ? {
            Employee: {
              departmentId,
            },
          }
        : {},
      include: {
        Employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            designation: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: { Employee: { firstName: 'asc' } },
    });

    res.json(rates);
  })
);

// ============================================
// PAYROLL DEDUCTIONS MANAGEMENT
// ============================================

// Create deduction
router.post(
  '/deductions',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = DeductionCreateSchema.parse(req.body);

    const employee = await prisma.employee.findUnique({
      where: { id: body.employeeId },
    });

    if (!employee) {
      throw new AppError('Employee not found', 404);
    }

    const deduction = await prisma.payrollDeduction.create({
      data: {
        employeeId: body.employeeId,
        deductionType: body.deductionType,
        amount: body.amount,
        reason: body.reason,
        description: body.description,
        month: body.month,
        status: 'pending',
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

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'CREATE_DEDUCTION',
        entityType: 'PayrollDeduction',
        entityId: deduction.id,
        newValue: JSON.stringify({
          employeeId: body.employeeId,
          deductionType: body.deductionType,
          amount: body.amount,
          month: body.month,
        }),
      },
    });

    res.status(201).json(deduction);
  })
);

// Approve deduction
router.put(
  '/deductions/:deductionId/approve',
  requireRole('super_admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { deductionId } = z.object({ deductionId: z.string() }).parse(req.params);
    const { notes } = z.object({ notes: z.string().optional() }).parse(req.body);

    const deduction = await prisma.payrollDeduction.findUnique({
      where: { id: deductionId },
    });

    if (!deduction) {
      throw new AppError('Deduction not found', 404);
    }

    const updated = await prisma.payrollDeduction.update({
      where: { id: deductionId },
      data: {
        status: 'approved',
        approvedBy: req.user!.id,
        approvedAt: new Date(),
        notes: notes ?? deduction.notes,
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

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'APPROVE_DEDUCTION',
        entityType: 'PayrollDeduction',
        entityId: deductionId,
        newValue: JSON.stringify({ status: 'approved' }),
      },
    });

    res.json(updated);
  })
);

// Reject deduction
router.put(
  '/deductions/:deductionId/reject',
  requireRole('super_admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { deductionId } = z.object({ deductionId: z.string() }).parse(req.params);
    const { reason } = z.object({ reason: z.string() }).parse(req.body);

    const deduction = await prisma.payrollDeduction.findUnique({
      where: { id: deductionId },
    });

    if (!deduction) {
      throw new AppError('Deduction not found', 404);
    }

    const updated = await prisma.payrollDeduction.update({
      where: { id: deductionId },
      data: {
        status: 'rejected',
        approvedBy: req.user!.id,
        approvedAt: new Date(),
        notes: reason,
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

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'REJECT_DEDUCTION',
        entityType: 'PayrollDeduction',
        entityId: deductionId,
        newValue: JSON.stringify({ status: 'rejected', reason }),
      },
    });

    res.json(updated);
  })
);

// Get deductions for employee
router.get(
  '/deductions/employee/:employeeId',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId } = z.object({ employeeId: z.string() }).parse(req.params);
    const { month, status } = z
      .object({
        month: z.string().optional(),
        status: z.string().optional(),
      })
      .parse(req.query);

    const where: any = {
      employeeId,
    };

    if (month) {
      const monthDate = new Date(month);
      const startOfMonth = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
      const endOfMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);

      where.month = {
        gte: startOfMonth,
        lte: endOfMonth,
      };
    }

    if (status) {
      where.status = status as any; // Prisma enum/string handling
    }

    const deductions = await prisma.payrollDeduction.findMany({
      where,
      include: {
        Employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
          },
        },
        ApprovedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { month: 'desc' },
    });

    res.json(deductions);
  })
);

// Get all pending deductions
router.get(
  '/deductions/pending',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const deductions = await prisma.payrollDeduction.findMany({
      where: { status: 'pending' },
      include: {
        Employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            designation: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(deductions);
  })
);

// ============================================
// INFRACTIONS MANAGEMENT
// ============================================

// Create infraction
router.post(
  '/infractions',
  requireRole('super_admin', 'admin', 'manager'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = InfractionCreateSchema.parse(req.body);

    const employee = await prisma.employee.findUnique({
      where: { id: body.employeeId },
    });

    if (!employee) {
      throw new AppError('Employee not found', 404);
    }

    const infraction = await prisma.infraction.create({
      data: {
        employeeId: body.employeeId,
        type: body.type,
        severity: body.severity,
        amount: body.amount,
        description: body.description,
        date: body.date,
        reportedBy: req.user!.id,
        status: 'pending',
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
        ReportedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'CREATE_INFRACTION',
        entityType: 'Infraction',
        entityId: infraction.id,
        newValue: JSON.stringify({
          employeeId: body.employeeId,
          type: body.type,
          severity: body.severity,
          amount: body.amount,
        }),
      },
    });

    res.status(201).json(infraction);
  })
);

// Approve infraction
router.put(
  '/infractions/:infractionId/approve',
  requireRole('super_admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { infractionId } = z.object({ infractionId: z.string() }).parse(req.params);
    const { notes, autoCreateDeduction = true } = z
      .object({
        notes: z.string().optional(),
        autoCreateDeduction: z.boolean().optional().default(true),
      })
      .parse(req.body);

    const infraction = await prisma.infraction.findUnique({
      where: { id: infractionId },
    });

    if (!infraction) {
      throw new AppError('Infraction not found', 404);
    }

    const updated = await prisma.infraction.update({
      where: { id: infractionId },
      data: {
        status: 'approved',
        approvedBy: req.user!.id,
        approvedAt: new Date(),
        notes: notes ?? infraction.notes ?? undefined,
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

    if (autoCreateDeduction && infraction.amount && infraction.amount > 0) {
      await prisma.payrollDeduction.create({
        data: {
          employeeId: infraction.employeeId,
          deductionType: 'infraction',
          amount: infraction.amount,
          reason: `Deduction for ${infraction.type}`,
          description: infraction.description,
          month: infraction.date,
          status: 'approved',
          approvedBy: req.user!.id,
          approvedAt: new Date(),
        },
      });
    }

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'APPROVE_INFRACTION',
        entityType: 'Infraction',
        entityId: infractionId,
        newValue: JSON.stringify({ status: 'approved' }),
      },
    });

    res.json(updated);
  })
);

// Reject infraction
router.put(
  '/infractions/:infractionId/reject',
  requireRole('super_admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { infractionId } = z.object({ infractionId: z.string() }).parse(req.params);
    const { reason } = z.object({ reason: z.string() }).parse(req.body);

    const infraction = await prisma.infraction.findUnique({
      where: { id: infractionId },
    });

    if (!infraction) {
      throw new AppError('Infraction not found', 404);
    }

    const updated = await prisma.infraction.update({
      where: { id: infractionId },
      data: {
        status: 'rejected',
        approvedBy: req.user!.id,
        approvedAt: new Date(),
        notes: reason,
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

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'REJECT_INFRACTION',
        entityType: 'Infraction',
        entityId: infractionId,
        newValue: JSON.stringify({ status: 'rejected', reason }),
      },
    });

    res.json(updated);
  })
);

// Get infractions for employee
router.get(
  '/infractions/employee/:employeeId',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId } = z.object({ employeeId: z.string() }).parse(req.params);
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);

    const where: any = {
      employeeId,
    };

    if (status) {
      where.status = status as any;
    }

    const infractions = await prisma.infraction.findMany({
      where,
      include: {
        Employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
          },
        },
        ReportedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        ApprovedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { date: 'desc' },
    });

    res.json(infractions);
  })
);

// Get all pending infractions
router.get(
  '/infractions/pending',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const infractions = await prisma.infraction.findMany({
      where: { status: 'pending' },
      include: {
        Employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            designation: true,
            department: { select: { name: true } },
          },
        },
        ReportedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { date: 'desc' },
    });

    res.json(infractions);
  })
);

export default router;