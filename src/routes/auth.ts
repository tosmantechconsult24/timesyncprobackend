import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { asyncHandler } from '../middleware/errorHandler';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(['admin', 'manager', 'employee']).optional()
});

// Login
router.post('/login', asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = loginSchema.parse(req.body);
  logger.info(`Login attempt for email: ${email}`);
  
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() }
  });
  
  if (!user) {
    logger.warn(`Login failed: user not found with email ${email}`);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (!user.isActive) {
    return res.status(401).json({ error: 'Account is deactivated' });
  }
  
  const isValidPassword = await bcrypt.compare(password, user.password);
  
  if (!isValidPassword) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  
  const token = jwt.sign(
    { userId: user.id },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any }
  );
  
  const refreshToken = jwt.sign(
    { userId: user.id, type: 'refresh' },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '30d') as any }
  );
  
  // Log login activity
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'login',
      entityType: 'user',
      entityId: user.id,
      ipAddress: req.ip || undefined,
      userAgent: req.headers['user-agent'] || undefined
    }
  });
  
  logger.info(`User logged in: ${user.email}`);
  
  // Parse permissions safely
  let permissions: string[] = [];
  try {
    permissions = JSON.parse(user.permissions);
  } catch {
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
router.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required' });
  }
  
  try {
    const decoded = jwt.verify(
      refreshToken,
      process.env.JWT_SECRET || 'your-secret-key'
    ) as { userId: string; type: string };
    
    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });
    
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }
    
    const newToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any }
    );
    
    res.json({ token: newToken });
  } catch (error) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
}));

// Get current user
router.get('/me', authMiddleware, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: {
      Employee: true
    }
  });
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  // Parse permissions safely
  let permissions: string[] = [];
  try {
    permissions = JSON.parse(user.permissions);
  } catch {
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
router.post('/change-password', authMiddleware, asyncHandler(async (req: AuthRequest, res: Response) => {
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
  
  const user = await prisma.user.findUnique({
    where: { id: req.user.id }
  });
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const isValid = await bcrypt.compare(currentPassword, user.password);
  
  if (!isValid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  
  const hashedPassword = await bcrypt.hash(newPassword, 12);
  
  await prisma.user.update({
    where: { id: user.id },
    data: { password: hashedPassword }
  });
  
  await prisma.auditLog.create({
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
router.post('/logout', authMiddleware, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  await prisma.auditLog.create({
    data: {
      userId: req.user.id,
      action: 'logout',
      entityType: 'user',
      entityId: req.user.id
    }
  });
  
  res.json({ message: 'Logged out successfully' });
}));

export default router;
