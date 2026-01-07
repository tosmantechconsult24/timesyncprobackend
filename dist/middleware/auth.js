"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireRole = exports.requirePermission = exports.authMiddleware = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = require("../utils/prisma");
const logger_1 = require("../utils/logger");
const authMiddleware = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        const token = authHeader.split(' ')[1];
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET || 'your-secret-key');
        const user = await prisma_1.prisma.user.findUnique({
            where: { id: decoded.userId }
        });
        if (!user || !user.isActive) {
            return res.status(401).json({ error: 'User not found or inactive' });
        }
        req.user = {
            id: user.id,
            email: user.email,
            role: user.role,
            permissions: JSON.parse(user.permissions),
            firstName: user.firstName,
            lastName: user.lastName
        };
        next();
    }
    catch (error) {
        if (error instanceof jsonwebtoken_1.default.TokenExpiredError) {
            return res.status(401).json({ error: 'Token expired' });
        }
        if (error instanceof jsonwebtoken_1.default.JsonWebTokenError) {
            return res.status(401).json({ error: 'Invalid token' });
        }
        logger_1.logger.error('Auth middleware error:', error);
        return res.status(500).json({ error: 'Authentication failed' });
    }
};
exports.authMiddleware = authMiddleware;
const requirePermission = (...permissions) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        // Super admin has all permissions
        if (req.user.role === 'super_admin') {
            return next();
        }
        const userPermissions = req.user.permissions;
        const hasPermission = permissions.some(p => userPermissions.includes(p));
        if (!hasPermission) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
};
exports.requirePermission = requirePermission;
const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient role privileges' });
        }
        next();
    };
};
exports.requireRole = requireRole;
//# sourceMappingURL=auth.js.map