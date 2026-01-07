"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../utils/prisma");
const errorHandler_1 = require("../middleware/errorHandler");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const departmentSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    description: zod_1.z.string().optional().nullable(),
    managerId: zod_1.z.string().optional().nullable(),
    color: zod_1.z.string().optional().nullable(),
    budget: zod_1.z.number().optional().nullable(),
    isActive: zod_1.z.boolean().optional(),
});
// Get all departments
router.get('/', (0, auth_1.requirePermission)('departments:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const departments = await prisma_1.prisma.department.findMany({
        orderBy: { name: 'asc' },
        include: {
            _count: {
                select: {
                    employees: true,
                },
            },
        },
    });
    // Manually count active employees per department
    const activeEmployeeCounts = await prisma_1.prisma.employee.groupBy({
        by: ['departmentId'],
        where: { status: 'active' },
        _count: { id: true },
    });
    const activeCountMap = new Map(activeEmployeeCounts
        .filter((g) => g.departmentId !== null)
        .map((g) => [g.departmentId, g._count.id]));
    // Get manager names
    const managerIds = departments.filter((d) => d.managerId).map((d) => d.managerId);
    const managers = managerIds.length
        ? await prisma_1.prisma.employee.findMany({
            where: { id: { in: managerIds } },
            select: { id: true, firstName: true, lastName: true },
        })
        : [];
    const managerMap = new Map(managers.map((m) => [m.id, `${m.firstName} ${m.lastName}`]));
    const result = departments.map((dept) => ({
        ...dept,
        employeeCount: activeCountMap.get(dept.id) ?? 0,
        managerName: dept.managerId ? managerMap.get(dept.managerId) ?? null : null,
    }));
    res.json(result);
}));
// Get department by ID
router.get('/:id', (0, auth_1.requirePermission)('departments:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const department = await prisma_1.prisma.department.findUnique({
        where: { id: req.params.id },
        include: {
            employees: {
                where: { status: 'active' },
                select: {
                    id: true,
                    employeeId: true,
                    firstName: true,
                    lastName: true,
                    designation: true,
                    photo: true,
                },
            },
        },
    });
    if (!department) {
        throw new errorHandler_1.AppError('Department not found', 404);
    }
    res.json(department);
}));
// Create department
router.post('/', (0, auth_1.requirePermission)('departments:write'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const data = departmentSchema.parse(req.body);
    const existing = await prisma_1.prisma.department.findUnique({
        where: { name: data.name },
    });
    if (existing) {
        throw new errorHandler_1.AppError('Department with this name already exists', 409);
    }
    const department = await prisma_1.prisma.department.create({
        data: {
            ...data,
        },
    });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'create',
            entityType: 'department',
            entityId: department.id,
            newValue: JSON.stringify(department),
        },
    });
    res.status(201).json(department);
}));
// Update department
router.put('/:id', (0, auth_1.requirePermission)('departments:write'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const existing = await prisma_1.prisma.department.findUnique({
        where: { id: req.params.id },
    });
    if (!existing) {
        throw new errorHandler_1.AppError('Department not found', 404);
    }
    const data = departmentSchema.partial().parse(req.body);
    // Check for duplicate name
    if (data.name && data.name !== existing.name) {
        const duplicate = await prisma_1.prisma.department.findUnique({
            where: { name: data.name },
        });
        if (duplicate) {
            throw new errorHandler_1.AppError('Department with this name already exists', 409);
        }
    }
    const department = await prisma_1.prisma.department.update({
        where: { id: req.params.id },
        data,
    });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'update',
            entityType: 'department',
            entityId: department.id,
            oldValue: JSON.stringify(existing),
            newValue: JSON.stringify(department),
        },
    });
    res.json(department);
}));
// Delete department
router.delete('/:id', (0, auth_1.requirePermission)('departments:delete'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const department = await prisma_1.prisma.department.findUnique({
        where: { id: req.params.id },
        include: {
            _count: { select: { employees: true } },
        },
    });
    if (!department) {
        throw new errorHandler_1.AppError('Department not found', 404);
    }
    // Move employees to no department
    if (department._count.employees > 0) {
        await prisma_1.prisma.employee.updateMany({
            where: { departmentId: req.params.id },
            data: { departmentId: null },
        });
    }
    await prisma_1.prisma.department.delete({
        where: { id: req.params.id },
    });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'delete',
            entityType: 'department',
            entityId: req.params.id,
            oldValue: JSON.stringify(department),
        },
    });
    res.json({ message: 'Department deleted successfully' });
}));
// Get department statistics
router.get('/:id/stats', (0, auth_1.requirePermission)('departments:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const department = await prisma_1.prisma.department.findUnique({
        where: { id: req.params.id },
    });
    if (!department) {
        throw new errorHandler_1.AppError('Department not found', 404);
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [employeeCount, presentToday, onLeaveToday] = await Promise.all([
        prisma_1.prisma.employee.count({
            where: { departmentId: req.params.id, status: 'active' },
        }),
        prisma_1.prisma.timeEntry.count({
            where: {
                Employee: { departmentId: req.params.id },
                clockIn: { gte: today },
            },
        }),
        prisma_1.prisma.leaveRequest.count({
            where: {
                Employee: { departmentId: req.params.id },
                status: 'approved',
                startDate: { lte: today },
                endDate: { gte: today },
            },
        }),
    ]);
    res.json({
        employeeCount,
        presentToday,
        onLeaveToday,
        absentToday: employeeCount - presentToday - onLeaveToday,
    });
}));
exports.default = router;
//# sourceMappingURL=departments.js.map