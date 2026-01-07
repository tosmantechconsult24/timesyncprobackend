import { Router, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuthRequest, requirePermission, requireRole } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();

// Settings routes
router.get('/', requirePermission('settings:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { category } = req.query;
  
  const where = category ? { category: category as string } : {};
  
  const settings = await prisma.setting.findMany({
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
  }, {} as Record<string, typeof settings>);
  
  res.json(grouped);
}));

router.get('/:key', requirePermission('settings:read'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const setting = await prisma.setting.findUnique({
    where: { key: req.params.key }
  });
  
  if (!setting) {
    throw new AppError('Setting not found', 404);
  }
  
  res.json(setting);
}));

router.put('/:key', requireRole('super_admin'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { value } = req.body;
  
  if (value === undefined) {
    throw new AppError('Value is required', 400);
  }
  
  const setting = await prisma.setting.upsert({
    where: { key: req.params.key },
    update: { value: String(value) },
    create: {
      id: randomUUID(),
      key: req.params.key,
      value: String(value),
      category: req.body.category || 'general',
      updatedAt: new Date(),
    }
  });
  
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'update',
      entityType: 'setting',
      entityId: setting.id,
      newValue: JSON.stringify({ key: req.params.key, value })
    }
  });
  
  res.json(setting);
}));

// Bulk update settings
router.post('/bulk', requireRole('super_admin'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { settings } = req.body;
  
  if (!Array.isArray(settings)) {
    throw new AppError('Settings must be an array', 400);
  }
  
  const updated = [];
  
  for (const { key, value, category } of settings) {
    const setting = await prisma.setting.upsert({
      where: { key },
      update: { value: String(value) },
      create: {
        id: randomUUID(),
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

export default router;
