import { randomBytes } from 'node:crypto';

import bcrypt from 'bcrypt';
import express from 'express';

import { userDb } from '../modules/database/index.js';
import { getConnection } from '../modules/database/connection.js';
import {
  generateToken,
  authenticateToken,
  IS_LOCAL_ONLY_AUTH,
  getLocalOnlyUser,
  getRequestToken,
  isLocalOnlyAuthToken,
} from '../middleware/auth.js';

const router = express.Router();
const db = getConnection();
const LOCAL_BOOTSTRAP_TTL_MS = 2 * 60 * 1000;
const localBootstrapCodes = new Map<string, { expiresAt: number; token: string }>();

function pruneLocalBootstrapCodes(now = Date.now()) {
  for (const [code, record] of localBootstrapCodes) {
    if (record.expiresAt <= now) localBootstrapCodes.delete(code);
  }
  while (localBootstrapCodes.size > 20) {
    const oldestCode = localBootstrapCodes.keys().next().value;
    if (typeof oldestCode !== 'string') break;
    localBootstrapCodes.delete(oldestCode);
  }
}

function toNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error as NodeJS.ErrnoException : new Error(String(error));
}

// Check auth status and setup requirements
router.get('/status', async (req, res) => {
  try {
    if (IS_LOCAL_ONLY_AUTH) {
      const user = getLocalOnlyUser();
      const isAuthenticated = isLocalOnlyAuthToken(getRequestToken(req));
      return res.json({
        needsSetup: false,
        isAuthenticated,
        localOnly: true,
        user: isAuthenticated ? { id: user.id, username: user.username } : null,
      });
    }

    const hasUsers = await userDb.hasUsers();
    res.json({ 
      needsSetup: !hasUsers,
      isAuthenticated: false // Will be overridden by frontend if token exists
    });
  } catch (error) {
    console.error('Auth status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// The desktop app uses its private local token to mint a short-lived code for
// opening the UI in a normal browser. The browser exchanges it once, then
// removes the code from the address bar before rendering the workspace.
router.post('/local-bootstrap', (req, res) => {
  if (!IS_LOCAL_ONLY_AUTH) return res.status(404).json({ error: 'Not found' });
  const token = getRequestToken(req);
  if (!isLocalOnlyAuthToken(token)) {
    return res.status(403).json({ error: 'Invalid local desktop authorization.' });
  }

  pruneLocalBootstrapCodes();
  const code = randomBytes(24).toString('base64url');
  localBootstrapCodes.set(code, { token: token!, expiresAt: Date.now() + LOCAL_BOOTSTRAP_TTL_MS });
  return res.json({ code, expiresInMs: LOCAL_BOOTSTRAP_TTL_MS });
});

router.post('/local-bootstrap/exchange', (req, res) => {
  if (!IS_LOCAL_ONLY_AUTH) return res.status(404).json({ error: 'Not found' });
  pruneLocalBootstrapCodes();
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  const record = localBootstrapCodes.get(code);
  if (!record) {
    return res.status(403).json({ error: 'Local browser authorization expired or was already used.' });
  }

  localBootstrapCodes.delete(code);
  if (record.expiresAt <= Date.now()) {
    return res.status(403).json({ error: 'Local browser authorization expired.' });
  }
  const user = getLocalOnlyUser();
  return res.json({
    success: true,
    localOnly: true,
    user: { id: user.id, username: user.username },
    token: record.token,
  });
});

// User registration (setup) - only allowed if no users exist
router.post('/register', async (req, res) => {
  try {
    if (IS_LOCAL_ONLY_AUTH) {
      const token = getRequestToken(req);
      if (!isLocalOnlyAuthToken(token)) {
        return res.status(403).json({ error: 'Local-only mode is unlocked by the leocodebox desktop app.' });
      }
      const user = getLocalOnlyUser();
      return res.json({
        success: true,
        localOnly: true,
        user: { id: user.id, username: user.username },
        token,
      });
    }

    const { username, password } = req.body;
    
    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username must be at least 3 characters, password at least 6 characters' });
    }
    
    // Use a transaction to prevent race conditions
    db.prepare('BEGIN').run();
    try {
      // Check if users already exist (only allow one user)
      const hasUsers = userDb.hasUsers();
      if (hasUsers) {
        db.prepare('ROLLBACK').run();
        return res.status(403).json({ error: 'User already exists. This is a single-user system.' });
      }
      
      // Hash password
      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      
      // Create user
      const user = userDb.createUser(username, passwordHash);
      
      // Generate token
      const token = generateToken(user);
      
      db.prepare('COMMIT').run();

      // Update last login (non-fatal, outside transaction)
      userDb.updateLastLogin(user.id);

      res.json({
        success: true,
        user: { id: user.id, username: user.username },
        token
      });
    } catch (error) {
      db.prepare('ROLLBACK').run();
      throw error;
    }
    
  } catch (error) {
    console.error('Registration error:', error);
    if (toNodeError(error).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// User login
router.post('/login', async (req, res) => {
  try {
    if (IS_LOCAL_ONLY_AUTH) {
      const token = getRequestToken(req);
      if (!isLocalOnlyAuthToken(token)) {
        return res.status(403).json({ error: 'Local-only mode is unlocked by the leocodebox desktop app.' });
      }
      const user = getLocalOnlyUser();
      return res.json({
        success: true,
        localOnly: true,
        user: { id: user.id, username: user.username },
        token,
      });
    }

    const { username, password } = req.body;
    
    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    // Get user from database
    const user = userDb.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    // Generate token
    const token = generateToken(user);
    
    // Update last login
    userDb.updateLastLogin(user.id);
    
    res.json({
      success: true,
      user: { id: user.id, username: user.username },
      token
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user (protected route)
router.get('/user', authenticateToken, (req, res) => {
  res.json({
    user: req.user
  });
});

// Logout (client-side token removal, but this endpoint can be used for logging)
router.post('/logout', authenticateToken, (req, res) => {
  // In a simple JWT system, logout is mainly client-side
  // This endpoint exists for consistency and potential future logging
  res.json({ success: true, message: 'Logged out successfully' });
});

export default router;
