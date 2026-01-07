"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = require("crypto");
const prisma_1 = require("../utils/prisma");
const errorHandler_1 = require("../middleware/errorHandler");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Settings routes
router.get('/', (0, auth_1.requirePermission)('settings:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { category } = req.query;
    const where = category ? { category: category } : {};
    const settings = await prisma_1.prisma.setting.findMany({
        where,
        orderBy: { category: 'asc' }
    });
    // Group by category
    const grouped = settings.reduce((acc, setting) => {
        if (!acc[setting.category]) {
            acc[setting.category] = [];
        }
        acc[setting.category].push(setting);
        return acc;
    }, {});
    res.json(grouped);
}));
router.get('/:key', (0, auth_1.requirePermission)('settings:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const setting = await prisma_1.prisma.setting.findUnique({
        where: { key: req.params.key }
    });
    if (!setting) {
        throw new errorHandler_1.AppError('Setting not found', 404);
    }
    res.json(setting);
}));
router.put('/:key', (0, auth_1.requireRole)('super_admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { value } = req.body;
    if (value === undefined) {
        throw new errorHandler_1.AppError('Value is required', 400);
    }
    const setting = await prisma_1.prisma.setting.upsert({
        where: { key: req.params.key },
        update: { value: String(value) },
        create: {
            id: (0, crypto_1.randomUUID)(),
            key: req.params.key,
            value: String(value),
            category: req.body.category || 'general',
            updatedAt: new Date(),
        }
    });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'update',
            entityType: 'setting',
            entityId: setting.id,
            newValue: JSON.stringify({ key: req.params.key, value })
        }
    });
    res.json(setting);
}));
// Bulk update settings
router.post('/bulk', (0, auth_1.requireRole)('super_admin'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { settings } = req.body;
    if (!Array.isArray(settings)) {
        throw new errorHandler_1.AppError('Settings must be an array', 400);
    }
    const updated = [];
    for (const { key, value, category } of settings) {
        const setting = await prisma_1.prisma.setting.upsert({
            where: { key },
            update: { value: String(value) },
            create: {
                id: (0, crypto_1.randomUUID)(),
                key,
                value: String(value),
                category: category || 'general',
                updatedAt: new Date(),
            }
        });
        updated.push(setting);
    }
    res.json(updated);
}));
exports.default = router;
//# sourceMappingURL=settings.js.map