"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const crypto_1 = require("crypto");
const prisma_1 = require("../utils/prisma");
const logger_1 = require("../utils/logger");
const errorHandler_1 = require("../middleware/errorHandler");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const shiftSchema = zod_1.z.object({
    name: zod_1.z.string().min(1, 'Name is required'),
    description: zod_1.z.string().optional().nullable().default(''),
    startTime: zod_1.z.string().regex(/^\d{2}:\d{2}$/, 'Start time must be HH:MM format'),
    endTime: zod_1.z.string().regex(/^\d{2}:\d{2}$/, 'End time must be HH:MM format'),
    breakDuration: zod_1.z.coerce.number().default(60),
    graceMinutes: zod_1.z.coerce.number().default(15),
    overtimeAfter: zod_1.z.coerce.number().default(8),
    workingDays: zod_1.z.any().optional(), // Accept any format, we'll handle it
    color: zod_1.z.string().optional().nullable().default('#10B981'),
    isNightShift: zod_1.z.coerce.boolean().default(false),
    isActive: zod_1.z.coerce.boolean().default(true)
}).passthrough(); // Allow extra fields
const shiftAssignmentSchema = zod_1.z.object({
    employeeId: zod_1.z.string(),
    shiftId: zod_1.z.string(),
    startDate: zod_1.z.string(),
    endDate: zod_1.z.string().optional().nullable()
});
// Get all shifts
router.get('/', (0, auth_1.requirePermission)('shifts:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const shifts = await prisma_1.prisma.shift.findMany({
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
router.get('/:id', (0, auth_1.requirePermission)('shifts:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const shift = await prisma_1.prisma.shift.findUnique({
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
        throw new errorHandler_1.AppError('Shift not found', 404);
    }
    res.json({
        ...shift,
        workingDays: JSON.parse(shift.workingDays)
    });
}));
// Create shift
router.post('/', (0, auth_1.requirePermission)('shifts:write'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    // Validate and parse request body
    const parseResult = shiftSchema.safeParse(req.body);
    if (!parseResult.success) {
        logger_1.logger.error('Shift validation error:', parseResult.error.errors);
        throw new errorHandler_1.AppError(`Validation error: ${parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`, 400);
    }
    const data = parseResult.data;
    // Handle workingDays - convert string to array if needed
    let workingDays = data.workingDays || [1, 2, 3, 4, 5];
    if (typeof workingDays === 'string') {
        workingDays = JSON.parse(workingDays);
    }
    const shift = await prisma_1.prisma.shift.create({
        data: {
            ...data,
            workingDays: JSON.stringify(workingDays),
            breakDuration: data.breakDuration || 60,
            graceMinutes: data.graceMinutes || 15,
            overtimeAfter: data.overtimeAfter || 8,
        },
    });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
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
router.put('/:id', (0, auth_1.requirePermission)('shifts:write'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const existing = await prisma_1.prisma.shift.findUnique({
        where: { id: req.params.id }
    });
    if (!existing) {
        throw new errorHandler_1.AppError('Shift not found', 404);
    }
    const data = shiftSchema.partial().parse(req.body);
    // Handle workingDays - convert string to array if needed
    let workingDays = undefined;
    if (data.workingDays !== undefined) {
        workingDays = data.workingDays;
        if (typeof workingDays === 'string') {
            workingDays = JSON.parse(workingDays);
        }
    }
    const shift = await prisma_1.prisma.shift.update({
        where: { id: req.params.id },
        data: {
            ...data,
            workingDays: workingDays ? JSON.stringify(workingDays) : undefined,
            breakDuration: data.breakDuration || existing.breakDuration,
            graceMinutes: data.graceMinutes || existing.graceMinutes,
            overtimeAfter: data.overtimeAfter || existing.overtimeAfter,
        }
    });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
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
router.delete('/:id', (0, auth_1.requirePermission)('shifts:delete'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const shift = await prisma_1.prisma.shift.findUnique({
        where: { id: req.params.id },
        include: {
            _count: { select: { employees: true } }
        }
    });
    if (!shift) {
        throw new errorHandler_1.AppError('Shift not found', 404);
    }
    // Remove shift assignment from employees
    if (shift._count.employees > 0) {
        await prisma_1.prisma.employee.updateMany({
            where: { shiftId: req.params.id },
            data: { shiftId: null }
        });
    }
    // Delete shift assignments
    await prisma_1.prisma.shiftAssignment.deleteMany({
        where: { shiftId: req.params.id }
    });
    await prisma_1.prisma.shift.delete({
        where: { id: req.params.id }
    });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'delete',
            entityType: 'shift',
            entityId: req.params.id,
            oldValue: JSON.stringify(shift)
        }
    });
    res.json({ message: 'Shift deleted successfully' });
}));
// Assign employees to shift
router.post('/assign', (0, auth_1.requirePermission)('shifts:write'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { employeeIds, shiftId, startDate, endDate } = req.body;
    if (!Array.isArray(employeeIds) || !shiftId) {
        throw new errorHandler_1.AppError('Invalid data', 400);
    }
    const shift = await prisma_1.prisma.shift.findUnique({
        where: { id: shiftId }
    });
    if (!shift) {
        throw new errorHandler_1.AppError('Shift not found', 404);
    }
    // Update employees' default shift
    await prisma_1.prisma.employee.updateMany({
        where: { id: { in: employeeIds } },
        data: { shiftId }
    });
    // Create shift assignments for tracking
    const assignments = employeeIds.map((employeeId, idx) => ({
        id: (0, crypto_1.randomUUID)(),
        employeeId,
        shiftId,
        startDate: startDate ? new Date(startDate) : new Date(),
        endDate: endDate ? new Date(endDate) : null,
        assignedById: req.user.id
    }));
    await prisma_1.prisma.shiftAssignment.createMany({
        data: assignments
    });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'assign',
            entityType: 'shiftAssignment',
            entityId: shiftId,
            newValue: JSON.stringify({ employeeIds, shiftId })
        }
    });
    res.json({ message: `${employeeIds.length} employees assigned to shift` });
}));
// Get shift schedule (weekly view)
router.get('/schedule/weekly', (0, auth_1.requirePermission)('shifts:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { startDate } = req.query;
    const start = startDate ? new Date(startDate) : new Date();
    start.setHours(0, 0, 0, 0);
    // Get start of week (Monday)
    const dayOfWeek = start.getDay();
    const diff = start.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    const weekStart = new Date(start.setDate(diff));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const [shifts, employees, assignments] = await Promise.all([
        prisma_1.prisma.shift.findMany({ where: { isActive: true } }),
        prisma_1.prisma.employee.findMany({
            where: { status: 'active' },
            include: {
                shift: true,
                department: { select: { name: true } }
            }
        }),
        prisma_1.prisma.shiftAssignment.findMany({
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
    const schedule = [];
    for (let i = 0; i < 7; i++) {
        const date = new Date(weekStart);
        date.setDate(date.getDate() + i);
        const dayNumber = date.getDay();
        const daySchedule = {
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
router.get('/unassigned', (0, auth_1.requirePermission)('shifts:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const employees = await prisma_1.prisma.employee.findMany({
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
exports.default = router;
//# sourceMappingURL=shifts.js.map