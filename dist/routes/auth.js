"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const zod_1 = require("zod");
const prisma_1 = require("../utils/prisma");
const logger_1 = require("../utils/logger");
const errorHandler_1 = require("../middleware/errorHandler");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(1)
});
const registerSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(8),
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    role: zod_1.z.enum(['admin', 'manager', 'employee']).optional()
});
// Login
router.post('/login', (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    logger_1.logger.info(`Login attempt for email: ${email}`);
    const user = await prisma_1.prisma.user.findUnique({
        where: { email: email.toLowerCase() }
    });
    if (!user) {
        logger_1.logger.warn(`Login failed: user not found with email ${email}`);
        return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!user.isActive) {
        return res.status(401).json({ error: 'Account is deactivated' });
    }
    const isValidPassword = await bcryptjs_1.default.compare(password, user.password);
    if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jsonwebtoken_1.default.sign({ userId: user.id }, process.env.JWT_SECRET || 'your-secret-key', { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') });
    const refreshToken = jsonwebtoken_1.default.sign({ userId: user.id, type: 'refresh' }, process.env.JWT_SECRET || 'your-secret-key', { expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '30d') });
    // Log login activity
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: user.id,
            action: 'login',
            entityType: 'user',
            entityId: user.id,
            ipAddress: req.ip || undefined,
            userAgent: req.headers['user-agent'] || undefined
        }
    });
    logger_1.logger.info(`User logged in: ${user.email}`);
    // Parse permissions safely
    let permissions = [];
    try {
        permissions = JSON.parse(user.permissions);
    }
    catch {
        permissions = [];
    }
    res.json({
        token,
        refreshToken,
        user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            permissions
        }
    });
}));
// Refresh token
router.post('/refresh', (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
        return res.status(401).json({ error: 'Refresh token required' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(refreshToken, process.env.JWT_SECRET || 'your-secret-key');
        if (decoded.type !== 'refresh') {
            return res.status(401).json({ error: 'Invalid refresh token' });
        }
        const user = await prisma_1.prisma.user.findUnique({
            where: { id: decoded.userId }
        });
        if (!user || !user.isActive) {
            return res.status(401).json({ error: 'User not found or inactive' });
        }
        const newToken = jsonwebtoken_1.default.sign({ userId: user.id }, process.env.JWT_SECRET || 'your-secret-key', { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') });
        res.json({ token: newToken });
    }
    catch (error) {
        return res.status(401).json({ error: 'Invalid refresh token' });
    }
}));
// Get current user
router.get('/me', auth_1.authMiddleware, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: req.user.id },
        include: {
            Employee: true
        }
    });
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    // Parse permissions safely
    let permissions = [];
    try {
        permissions = JSON.parse(user.permissions);
    }
    catch {
        permissions = [];
    }
    res.json({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        permissions,
        employee: user.Employee
    });
}));
// Change password
router.post('/change-password', auth_1.authMiddleware, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current and new password required' });
    }
    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: req.user.id }
    });
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    const isValid = await bcryptjs_1.default.compare(currentPassword, user.password);
    if (!isValid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hashedPassword = await bcryptjs_1.default.hash(newPassword, 12);
    await prisma_1.prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword }
    });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: user.id,
            action: 'change_password',
            entityType: 'user',
            entityId: user.id
        }
    });
    res.json({ message: 'Password changed successfully' });
}));
// Logout (for audit purposes)
router.post('/logout', auth_1.authMiddleware, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'logout',
            entityType: 'user',
            entityId: req.user.id
        }
    });
    res.json({ message: 'Logged out successfully' });
}));
exports.default = router;
//# sourceMappingURL=auth.js.map