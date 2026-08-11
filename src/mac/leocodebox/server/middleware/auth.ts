import { timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

import { userDb, appConfigDb } from '../modules/database/index.js';
import { IS_PLATFORM } from '../constants/config.js';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();
const IS_LOCAL_ONLY_AUTH = process.env.LEOCODEBOX_LOCAL_ONLY === '1' || process.env.CLOUDCLI_DESKTOP_LOCAL_ONLY === '1';
const getLocalOnlyUser = () => userDb.getOrCreateLocalUser();
const LOCAL_ONLY_AUTH_TOKEN = process.env.LEOCODEBOX_LOCAL_AUTH_TOKEN || process.env.CLOUDCLI_DESKTOP_LOCAL_AUTH_TOKEN || '';

type AuthUser = { id: number; username: string };
type AuthenticatedRequest = Request & { user?: AuthUser };

const safeTokenEquals = (actual: string | null | undefined, expected: string | null | undefined): boolean => {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
};

const isLocalOnlyAuthToken = (token: string | null | undefined): boolean => safeTokenEquals(token, LOCAL_ONLY_AUTH_TOKEN);

const getRequestToken = (req: Request): string | null => {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];
  return token || null;
};

// Optional API key middleware
const validateApiKey = (req: Request, res: Response, next: NextFunction) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }

  const apiKey = req.headers['x-api-key'];
  if (!safeTokenEquals(typeof apiKey === 'string' ? apiKey : null, process.env.API_KEY)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware
const authenticateToken = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (IS_LOCAL_ONLY_AUTH) {
    const token = getRequestToken(req);
    if (!isLocalOnlyAuthToken(token)) {
      return res.status(401).json({ error: 'Access denied. Invalid local auth token.' });
    }

    try {
      req.user = getLocalOnlyUser();
      return next();
    } catch (error) {
      console.error('Local-only auth error:', error);
      return res.status(500).json({ error: 'Local-only mode: Failed to prepare local user' });
    }
  }

  // Platform mode:  use single database user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const token = getRequestToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user still exists and is active
    const user = typeof decoded.userId === 'number' ? userDb.getUserById(decoded.userId) : undefined;
    if (!user) {
      return res.status(401).json({ error: 'Invalid token. User not found.' });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user);
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Generate JWT token
const generateToken = (user: AuthUser): string => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token: string | null | undefined): AuthUser | ({ userId: number; username: string }) | null => {
  if (IS_LOCAL_ONLY_AUTH) {
    if (!isLocalOnlyAuthToken(token)) {
      return null;
    }

    try {
      const user = getLocalOnlyUser();
      return { id: user.id, userId: user.id, username: user.username };
    } catch (error) {
      console.error('Local-only WebSocket auth error:', error);
      return null;
    }
  }

  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = typeof decoded.userId === 'number' ? userDb.getUserById(decoded.userId) : undefined;
    if (!user) {
      return null;
    }
    return { userId: user.id, username: user.username };
  } catch (error) {
    console.error('WebSocket token verification error:', error);
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET,
  IS_LOCAL_ONLY_AUTH,
  getLocalOnlyUser,
  getRequestToken,
  isLocalOnlyAuthToken,
  safeTokenEquals
};
