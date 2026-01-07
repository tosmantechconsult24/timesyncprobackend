"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// ============================================
// routes/payroll.ts - Payroll Management
// ============================================
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../utils/prisma");
const errorHandler_1 = require("../middleware/errorHandler");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// ============================================
// SCHEMAS
// ============================================
const EmployeeRateSchema = zod_1.z.object({
    hourlyRate: zod_1.z.number().optional(),
    dailyRate: zod_1.z.number().optional(),
    salary: zod_1.z.number().optional(),
    overtimeRate: zod_1.z.number().optional(),
    rateType: zod_1.z.enum(['hourly', 'daily', 'salary']).optional(),
    notes: zod_1.z.string().optional(),
});
const DeductionCreateSchema = zod_1.z.object({
    employeeId: zod_1.z.string(),
    deductionType: zod_1.z.string(),
    amount: zod_1.z.number().positive(),
    reason: zod_1.z.string(),
    description: zod_1.z.string().optional(),
    month: zod_1.z.string().pipe(zod_1.z.coerce.date()),
});
const InfractionCreateSchema = zod_1.z.object({
    employeeId: zod_1.z.string(),
    type: zod_1.z.string(),
    severity: zod_1.z.enum(['minor', 'moderate', 'major']).optional().default('minor'),
    amount: zod_1.z.number().min(0).optional(),
    description: zod_1.z.string(),
    date: zod_1.z.string().pipe(zod_1.z.coerce.date()),
});
// ============================================
// EMPLOYEE RATES MANAGEMENT
// ============================================
// Get employee rate
router.get('/rates/:employeeId', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { employeeId } = zod_1.z.object({ employeeId: zod_1.z.string() }).parse(req.params);
    const employeeRate = await prisma_1.prisma.employeeRate.findUnique({
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
        throw new errorHandler_1.AppError('Employee rate not found', 404);
    }
    res.json(employeeRate);
}));
// Create or update employee rate
router.put('/rates/:employeeId', (0, auth_1.requireRole)('super_admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { employeeId } = zod_1.z.object({ employeeId: zod_1.z.string() }).parse(req.params);
    const body = EmployeeRateSchema.parse(req.body);
    // Validate employee exists
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { id: employeeId },
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    const employeeRate = await prisma_1.prisma.employeeRate.upsert({
        where: { employeeId },
        create: {
            employeeId,
            hourlyRate: body.hourlyRate ?? 0,
            dailyRate: body.dailyRate,
            salary: body.salary,
            overtimeRate: body.overtimeRate ?? (body.hourlyRate ? body.hourlyRate * 1.5 : undefined),
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
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
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
}));
// Get all employee rates (optionally filtered by department)
router.get('/rates', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { departmentId } = zod_1.z
        .object({ departmentId: zod_1.z.string().optional() })
        .parse(req.query);
    const rates = await prisma_1.prisma.employeeRate.findMany({
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
}));
// ============================================
// PAYROLL DEDUCTIONS MANAGEMENT
// ============================================
// Create deduction
router.post('/deductions', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const body = DeductionCreateSchema.parse(req.body);
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { id: body.employeeId },
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    const deduction = await prisma_1.prisma.payrollDeduction.create({
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
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
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
}));
// Approve deduction
router.put('/deductions/:deductionId/approve', (0, auth_1.requireRole)('super_admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { deductionId } = zod_1.z.object({ deductionId: zod_1.z.string() }).parse(req.params);
    const { notes } = zod_1.z.object({ notes: zod_1.z.string().optional() }).parse(req.body);
    const deduction = await prisma_1.prisma.payrollDeduction.findUnique({
        where: { id: deductionId },
    });
    if (!deduction) {
        throw new errorHandler_1.AppError('Deduction not found', 404);
    }
    const updated = await prisma_1.prisma.payrollDeduction.update({
        where: { id: deductionId },
        data: {
            status: 'approved',
            approvedBy: req.user.id,
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
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'APPROVE_DEDUCTION',
            entityType: 'PayrollDeduction',
            entityId: deductionId,
            newValue: JSON.stringify({ status: 'approved' }),
        },
    });
    res.json(updated);
}));
// Reject deduction
router.put('/deductions/:deductionId/reject', (0, auth_1.requireRole)('super_admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { deductionId } = zod_1.z.object({ deductionId: zod_1.z.string() }).parse(req.params);
    const { reason } = zod_1.z.object({ reason: zod_1.z.string() }).parse(req.body);
    const deduction = await prisma_1.prisma.payrollDeduction.findUnique({
        where: { id: deductionId },
    });
    if (!deduction) {
        throw new errorHandler_1.AppError('Deduction not found', 404);
    }
    const updated = await prisma_1.prisma.payrollDeduction.update({
        where: { id: deductionId },
        data: {
            status: 'rejected',
            approvedBy: req.user.id,
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
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'REJECT_DEDUCTION',
            entityType: 'PayrollDeduction',
            entityId: deductionId,
            newValue: JSON.stringify({ status: 'rejected', reason }),
        },
    });
    res.json(updated);
}));
// Get deductions for employee
router.get('/deductions/employee/:employeeId', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { employeeId } = zod_1.z.object({ employeeId: zod_1.z.string() }).parse(req.params);
    const { month, status } = zod_1.z
        .object({
        month: zod_1.z.string().optional(),
        status: zod_1.z.string().optional(),
    })
        .parse(req.query);
    const where = {
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
        where.status = status; // Prisma enum/string handling
    }
    const deductions = await prisma_1.prisma.payrollDeduction.findMany({
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
}));
// Get all pending deductions
router.get('/deductions/pending', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const deductions = await prisma_1.prisma.payrollDeduction.findMany({
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
}));
// ============================================
// INFRACTIONS MANAGEMENT
// ============================================
// Create infraction
router.post('/infractions', (0, auth_1.requireRole)('super_admin', 'admin', 'manager'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const body = InfractionCreateSchema.parse(req.body);
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { id: body.employeeId },
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    const infraction = await prisma_1.prisma.infraction.create({
        data: {
            employeeId: body.employeeId,
            type: body.type,
            severity: body.severity,
            amount: body.amount,
            description: body.description,
            date: body.date,
            reportedBy: req.user.id,
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
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
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
}));
// Approve infraction
router.put('/infractions/:infractionId/approve', (0, auth_1.requireRole)('super_admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { infractionId } = zod_1.z.object({ infractionId: zod_1.z.string() }).parse(req.params);
    const { notes, autoCreateDeduction = true } = zod_1.z
        .object({
        notes: zod_1.z.string().optional(),
        autoCreateDeduction: zod_1.z.boolean().optional().default(true),
    })
        .parse(req.body);
    const infraction = await prisma_1.prisma.infraction.findUnique({
        where: { id: infractionId },
    });
    if (!infraction) {
        throw new errorHandler_1.AppError('Infraction not found', 404);
    }
    const updated = await prisma_1.prisma.infraction.update({
        where: { id: infractionId },
        data: {
            status: 'approved',
            approvedBy: req.user.id,
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
        await prisma_1.prisma.payrollDeduction.create({
            data: {
                employeeId: infraction.employeeId,
                deductionType: 'infraction',
                amount: infraction.amount,
                reason: `Deduction for ${infraction.type}`,
                description: infraction.description,
                month: infraction.date,
                status: 'approved',
                approvedBy: req.user.id,
                approvedAt: new Date(),
            },
        });
    }
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'APPROVE_INFRACTION',
            entityType: 'Infraction',
            entityId: infractionId,
            newValue: JSON.stringify({ status: 'approved' }),
        },
    });
    res.json(updated);
}));
// Reject infraction
router.put('/infractions/:infractionId/reject', (0, auth_1.requireRole)('super_admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { infractionId } = zod_1.z.object({ infractionId: zod_1.z.string() }).parse(req.params);
    const { reason } = zod_1.z.object({ reason: zod_1.z.string() }).parse(req.body);
    const infraction = await prisma_1.prisma.infraction.findUnique({
        where: { id: infractionId },
    });
    if (!infraction) {
        throw new errorHandler_1.AppError('Infraction not found', 404);
    }
    const updated = await prisma_1.prisma.infraction.update({
        where: { id: infractionId },
        data: {
            status: 'rejected',
            approvedBy: req.user.id,
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
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'REJECT_INFRACTION',
            entityType: 'Infraction',
            entityId: infractionId,
            newValue: JSON.stringify({ status: 'rejected', reason }),
        },
    });
    res.json(updated);
}));
// Get infractions for employee
router.get('/infractions/employee/:employeeId', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { employeeId } = zod_1.z.object({ employeeId: zod_1.z.string() }).parse(req.params);
    const { status } = zod_1.z.object({ status: zod_1.z.string().optional() }).parse(req.query);
    const where = {
        employeeId,
    };
    if (status) {
        where.status = status;
    }
    const infractions = await prisma_1.prisma.infraction.findMany({
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
}));
// Get all pending infractions
router.get('/infractions/pending', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const infractions = await prisma_1.prisma.infraction.findMany({
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
}));
exports.default = router;
//# sourceMappingURL=payroll.js.map