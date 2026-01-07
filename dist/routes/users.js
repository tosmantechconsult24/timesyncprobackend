"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const prisma_1 = require("../utils/prisma");
const errorHandler_1 = require("../middleware/errorHandler");
const auth_1 = require("../middleware/auth");
const logger_1 = require("../utils/logger");
const router = (0, express_1.Router)();
const userSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(8),
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    role: zod_1.z.enum(['super_admin', 'admin', 'manager', 'employee']),
    employeeId: zod_1.z.string().optional(), // Link to existing employee
    isActive: zod_1.z.boolean().optional()
});
// Role limits configuration
const ROLE_LIMITS = {
    super_admin: 5,
    admin: 20,
};
// Helper function to check role count
const getRoleCount = async (role) => {
    return prisma_1.prisma.user.count({
        where: { role, isActive: true }
    });
};
// Helper function to check if role limit reached
const isRoleLimitReached = async (role) => {
    if (!ROLE_LIMITS[role]) {
        return false; // No limit for this role
    }
    const count = await getRoleCount(role);
    return count >= ROLE_LIMITS[role];
};
// Get all users
router.get('/', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const users = await prisma_1.prisma.user.findMany({
        select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
            permissions: true,
            isActive: true,
            createdAt: true,
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
    });
    // Super admin can see all, admin can't see other admins/super_admins
    const filteredUsers = req.user.role === 'super_admin'
        ? users
        : users.filter(u => u.role === 'manager' || u.role === 'employee');
    res.json(filteredUsers.map(u => ({
        ...u,
        permissions: JSON.parse(u.permissions)
    })));
}));
// Get role statistics and limits
router.get('/admin/role-stats', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const stats = {
        super_admin: {
            count: await getRoleCount('super_admin'),
            limit: ROLE_LIMITS.super_admin,
            available: ROLE_LIMITS.super_admin - (await getRoleCount('super_admin'))
        },
        admin: {
            count: await getRoleCount('admin'),
            limit: ROLE_LIMITS.admin,
            available: ROLE_LIMITS.admin - (await getRoleCount('admin'))
        }
    };
    res.json(stats);
}));
// Get available employees (not yet users) for role assignment
router.get('/admin/available-employees', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const employees = await prisma_1.prisma.employee.findMany({
        where: {
            userId: null, // Not yet linked to a user account
            status: 'active'
        },
        select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            email: true,
            department: {
                select: {
                    id: true,
                    name: true
                }
            }
        },
        orderBy: { firstName: 'asc' }
    });
    res.json(employees);
}));
// Get user by ID
router.get('/:id', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: req.params.id },
        select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
            permissions: true,
            isActive: true,
            createdAt: true,
            Employee: {
                include: { department: true }
            }
        }
    });
    if (!user) {
        throw new errorHandler_1.AppError('User not found', 404);
    }
    // Admin can't view super_admin or other admin details
    if (req.user.role === 'admin' && (user.role === 'super_admin' || user.role === 'admin')) {
        throw new errorHandler_1.AppError('Access denied', 403);
    }
    res.json({
        ...user,
        permissions: JSON.parse(user.permissions)
    });
}));
// Create user (super_admin can create anyone, admin can create managers/employees)
router.post('/', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const data = userSchema.parse(req.body);
    // Admin can only create managers and employees
    if (req.user.role === 'admin' && (data.role === 'admin' || data.role === 'super_admin')) {
        throw new errorHandler_1.AppError('Admins cannot create admin or super_admin users', 403);
    }
    // Check role limits for super_admin and admin
    if (data.role === 'super_admin' || data.role === 'admin') {
        if (await isRoleLimitReached(data.role)) {
            const roleLimit = ROLE_LIMITS[data.role];
            throw new errorHandler_1.AppError(`Cannot create more ${data.role} users. Limit is ${roleLimit}.`, 400);
        }
    }
    // Check if email exists
    const existing = await prisma_1.prisma.user.findUnique({
        where: { email: data.email.toLowerCase() }
    });
    if (existing) {
        throw new errorHandler_1.AppError('Email already registered', 409);
    }
    // Define permissions based on role
    let permissions = [];
    switch (data.role) {
        case 'super_admin':
            // Super admin has all permissions
            permissions = [
                'employees:read', 'employees:write', 'employees:delete',
                'departments:read', 'departments:write', 'departments:delete',
                'shifts:read', 'shifts:write', 'shifts:delete',
                'attendance:read', 'attendance:write', 'attendance:delete',
                'leaves:read', 'leaves:write', 'leaves:approve',
                'reports:read', 'reports:export',
                'terminals:read', 'terminals:write', 'terminals:delete',
                'users:read', 'users:write', 'users:delete', // Can manage all users
                'settings:read', 'settings:write' // Full settings access
            ];
            break;
        case 'admin':
            // Admin has all permissions except super admin operations
            permissions = [
                'employees:read', 'employees:write', 'employees:delete',
                'departments:read', 'departments:write', 'departments:delete',
                'shifts:read', 'shifts:write', 'shifts:delete',
                'attendance:read', 'attendance:write', 'attendance:delete',
                'leaves:read', 'leaves:write', 'leaves:approve',
                'reports:read', 'reports:export',
                'terminals:read', 'terminals:write', 'terminals:delete',
                'users:read', 'users:write' // Can manage managers and employees only
            ];
            break;
        case 'manager':
            // Manager has limited permissions
            permissions = [
                'employees:read',
                'departments:read',
                'shifts:read',
                'attendance:read', 'attendance:write',
                'leaves:read', 'leaves:write', 'leaves:approve',
                'reports:read'
            ];
            break;
        case 'employee':
            // Employee has minimal permissions
            permissions = [
                'attendance:read', // Own attendance only
                'leaves:read', 'leaves:write' // Own leaves only
            ];
            break;
    }
    const hashedPassword = await bcryptjs_1.default.hash(data.password, 12);
    const user = await prisma_1.prisma.user.create({
        data: {
            email: data.email.toLowerCase(),
            password: hashedPassword,
            firstName: data.firstName,
            lastName: data.lastName,
            role: data.role,
            permissions: JSON.stringify(permissions),
            isActive: data.isActive ?? true
        }
    });
    // Link to employee if specified
    if (data.employeeId) {
        await prisma_1.prisma.employee.update({
            where: { id: data.employeeId },
            data: { userId: user.id }
        });
    }
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'create',
            entityType: 'user',
            entityId: user.id,
            newValue: JSON.stringify({ email: user.email, role: user.role })
        }
    });
    logger_1.logger.info(`User created: ${user.email} with role ${user.role}`);
    res.status(201).json({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        permissions,
        isActive: user.isActive
    });
}));
// Update user
router.put('/:id', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const existing = await prisma_1.prisma.user.findUnique({
        where: { id: req.params.id }
    });
    if (!existing) {
        throw new errorHandler_1.AppError('User not found', 404);
    }
    // Prevent modifying super_admin unless you are super_admin
    if (existing.role === 'super_admin' && req.user.role !== 'super_admin') {
        throw new errorHandler_1.AppError('Cannot modify super admin', 403);
    }
    // Admin can't modify other admins
    if (req.user.role === 'admin' && existing.role === 'admin' && existing.id !== req.user.id) {
        throw new errorHandler_1.AppError('Cannot modify other admin users', 403);
    }
    const { password, role, isActive, firstName, lastName, permissions } = req.body;
    // Admin can't promote to admin role
    if (req.user.role === 'admin' && role === 'admin') {
        throw new errorHandler_1.AppError('Cannot promote user to admin role', 403);
    }
    const updateData = {};
    if (firstName)
        updateData.firstName = firstName;
    if (lastName)
        updateData.lastName = lastName;
    if (isActive !== undefined)
        updateData.isActive = isActive;
    if (password) {
        updateData.password = await bcryptjs_1.default.hash(password, 12);
    }
    // Only super_admin can change role and permissions
    if (req.user.role === 'super_admin') {
        if (role)
            updateData.role = role;
        if (permissions)
            updateData.permissions = JSON.stringify(permissions);
    }
    const user = await prisma_1.prisma.user.update({
        where: { id: req.params.id },
        data: updateData,
        select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
            permissions: true,
            isActive: true
        }
    });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'update',
            entityType: 'user',
            entityId: user.id,
            oldValue: JSON.stringify({ role: existing.role }),
            newValue: JSON.stringify(updateData)
        }
    });
    res.json({
        ...user,
        permissions: JSON.parse(user.permissions)
    });
}));
// Delete user
router.delete('/:id', (0, auth_1.requireRole)('super_admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: req.params.id }
    });
    if (!user) {
        throw new errorHandler_1.AppError('User not found', 404);
    }
    if (user.role === 'super_admin') {
        throw new errorHandler_1.AppError('Cannot delete super admin', 403);
    }
    // Unlink from employee if linked
    await prisma_1.prisma.employee.updateMany({
        where: { userId: req.params.id },
        data: { userId: null }
    });
    await prisma_1.prisma.user.delete({
        where: { id: req.params.id }
    });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'delete',
            entityType: 'user',
            entityId: req.params.id,
            oldValue: JSON.stringify({ email: user.email, role: user.role })
        }
    });
    res.json({ message: 'User deleted successfully' });
}));
// Toggle user active status
router.post('/:id/toggle-active', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: req.params.id }
    });
    if (!user) {
        throw new errorHandler_1.AppError('User not found', 404);
    }
    if (user.role === 'super_admin') {
        throw new errorHandler_1.AppError('Cannot deactivate super admin', 403);
    }
    if (req.user.role === 'admin' && user.role === 'admin') {
        throw new errorHandler_1.AppError('Cannot modify other admin users', 403);
    }
    const updated = await prisma_1.prisma.user.update({
        where: { id: req.params.id },
        data: { isActive: !user.isActive },
        select: {
            id: true,
            email: true,
            isActive: true
        }
    });
    res.json(updated);
}));
// Reset user password
router.post('/:id/reset-password', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
        throw new errorHandler_1.AppError('Password must be at least 8 characters', 400);
    }
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: req.params.id }
    });
    if (!user) {
        throw new errorHandler_1.AppError('User not found', 404);
    }
    if (user.role === 'super_admin' && req.user.role !== 'super_admin') {
        throw new errorHandler_1.AppError('Cannot reset super admin password', 403);
    }
    if (req.user.role === 'admin' && user.role === 'admin') {
        throw new errorHandler_1.AppError('Cannot reset other admin passwords', 403);
    }
    const hashedPassword = await bcryptjs_1.default.hash(newPassword, 12);
    await prisma_1.prisma.user.update({
        where: { id: req.params.id },
        data: { password: hashedPassword }
    });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'reset_password',
            entityType: 'user',
            entityId: user.id
        }
    });
    res.json({ message: 'Password reset successfully' });
}));
// Get available permissions
router.get('/meta/permissions', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const allPermissions = {
        employees: ['employees:read', 'employees:write', 'employees:delete'],
        departments: ['departments:read', 'departments:write', 'departments:delete'],
        shifts: ['shifts:read', 'shifts:write', 'shifts:delete'],
        attendance: ['attendance:read', 'attendance:write', 'attendance:delete'],
        leaves: ['leaves:read', 'leaves:write', 'leaves:approve'],
        reports: ['reports:read', 'reports:export'],
        settings: ['settings:read', 'settings:write'],
        terminals: ['terminals:read', 'terminals:write', 'terminals:delete'],
        users: ['users:read', 'users:write', 'users:delete']
    };
    // Admin can't assign settings permissions
    if (req.user.role === 'admin') {
        const { settings, ...rest } = allPermissions;
        return res.json(rest);
    }
    res.json(allPermissions);
}));
// Get role templates
router.get('/meta/roles', (0, auth_1.requireRole)('super_admin', 'admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const roles = [
        {
            role: 'admin',
            name: 'Administrator',
            description: 'Full access except settings',
            permissions: [
                'employees:read', 'employees:write', 'employees:delete',
                'departments:read', 'departments:write', 'departments:delete',
                'shifts:read', 'shifts:write', 'shifts:delete',
                'attendance:read', 'attendance:write', 'attendance:delete',
                'leaves:read', 'leaves:write', 'leaves:approve',
                'reports:read', 'reports:export',
                'terminals:read', 'terminals:write', 'terminals:delete',
                'users:read', 'users:write'
            ]
        },
        {
            role: 'manager',
            name: 'Manager',
            description: 'Can manage team attendance and leaves',
            permissions: [
                'employees:read',
                'departments:read',
                'shifts:read',
                'attendance:read', 'attendance:write',
                'leaves:read', 'leaves:write', 'leaves:approve',
                'reports:read'
            ]
        },
        {
            role: 'employee',
            name: 'Employee',
            description: 'Basic access to own data',
            permissions: [
                'attendance:read',
                'leaves:read', 'leaves:write'
            ]
        }
    ];
    // Admin can't see/create admin role template
    if (req.user.role === 'admin') {
        res.json(roles.filter(r => r.role !== 'admin'));
    }
    else {
        res.json(roles);
    }
}));
exports.default = router;
//# sourceMappingURL=users.js.map