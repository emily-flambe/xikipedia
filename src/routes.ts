/**
 * API Route Handlers for Xikipedia
 *
 * All route handler functions, DB types, table initialization,
 * and the API_ROUTES map live here.
 */

import type { Logger } from './logger';
import { getCorsHeaders, jsonResponse, errorResponse, getClientIp } from './helpers';
import { atomicIncrement, resetRateLimit, rateLimitResponse, isRateLimitableIp } from './rate-limit';
import {
  arrayBufferToHex,
  hexToArrayBuffer,
  hashPassword,
  generateSalt,
  timingSafeEqual,
  createToken,
  authenticate,
  authCookieHeader,
  clearAuthCookieHeader,
  validatePassword,
  validateRegistration,
} from './auth';
import type { Env } from './index';

// ─── Types ───────────────────────────────────────────────────────────

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  salt: string;
  created_at: string;
  token_version: number;
}

interface PreferencesRow {
  user_id: number;
  category_scores: string;
  hidden_categories: string;
  settings: string;
  updated_at: string;
}

// ─── Database Initialization ─────────────────────────────────────────

let tablesInitialized = false;

export async function ensureTables(db: D1Database): Promise<void> {
  if (tablesInitialized) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      category_scores TEXT NOT NULL DEFAULT '{}',
      hidden_categories TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0
    )`),
  ]);
  // Schema migration: add settings column (safe if already exists)
  try {
    await db.prepare(
      `ALTER TABLE preferences ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'`,
    ).run();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // SQLite returns "duplicate column name" when column already exists
    if (!msg.includes('duplicate column')) {
      throw e; // Re-throw unexpected errors
    }
  }
  // Schema migration: add token_version column (safe if already exists)
  try {
    await db.prepare(
      'ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1',
    ).run();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('duplicate column')) {
      throw e;
    }
  }
  tablesInitialized = true;
}

// ─── Route Handlers ─────────────────────────────────────────────────

async function handleRegister(
  request: Request,
  env: Env,
  logger: Logger,
): Promise<Response> {
  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(request, 'Invalid JSON body', 400);
  }

  const validationError = validateRegistration(body.username, body.password);
  if (validationError) {
    return errorResponse(request, validationError, 400);
  }

  // Rate limit: 3 registrations per IP per hour (only valid requests count)
  // In production, CF-Connecting-IP is always set. Skip rate limiting for
  // unidentifiable clients (local dev) to avoid false positives.
  const ip = getClientIp(request);
  if (isRateLimitableIp(ip)) {
    const rl = await atomicIncrement(env.DB, `register:${ip}`, 3600);
    if (rl.count > 3) {
      return rateLimitResponse(request, rl.windowStart, 3600);
    }
  }

  const username = body.username as string;
  const password = body.password as string;

  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);
  const saltHex = arrayBufferToHex(salt.buffer as ArrayBuffer);

  try {
    const result = await env.DB.prepare(
      'INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)',
    )
      .bind(username, passwordHash, saltHex)
      .run();

    const userId = result.meta.last_row_id as number;

    const token = await createToken(
      {
        sub: userId,
        username,
        exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
        token_version: 1,
      },
      env.JWT_SECRET,
    );

    logger.info('auth.register.success', { username, userId });
    const resp = new Response(JSON.stringify({ username }), {
      status: 201,
      headers: {
        'Content-Type': 'application/json',
        ...getCorsHeaders(request),
        'Set-Cookie': authCookieHeader(token, request),
      },
    });
    return resp;
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (errMsg.includes('UNIQUE constraint failed') || errMsg.includes('SQLITE_CONSTRAINT')) {
      logger.warn('auth.register.failure', { username, reason: 'username_taken' });
      return errorResponse(request, 'Username already taken', 409);
    }
    logger.error('auth.register.failure', { username, reason: 'internal_error', error: errMsg });
    return errorResponse(request, 'Registration failed', 500);
  }
}

async function handleLogin(
  request: Request,
  env: Env,
  logger: Logger,
): Promise<Response> {
  const ip = getClientIp(request);
  const rateLimitKey = `login_fail:${ip}`;

  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(request, 'Invalid JSON body', 400);
  }

  if (typeof body.username !== 'string' || typeof body.password !== 'string' ||
      !body.username || !body.password) {
    return errorResponse(request, 'Username and password are required', 400);
  }

  const user = await env.DB.prepare(
    'SELECT id, username, password_hash, salt, token_version FROM users WHERE username = ?',
  )
    .bind(body.username)
    .first<UserRow>();

  if (!user) {
    if (isRateLimitableIp(ip)) {
      const rl = await atomicIncrement(env.DB, rateLimitKey, 900);
      if (rl.count > 5) {
        logger.warn('auth.login.failure', { reason: 'rate_limited' });
        return rateLimitResponse(request, rl.windowStart, 900);
      }
    }
    logger.warn('auth.login.failure', { username: body.username, reason: 'user_not_found' });
    return errorResponse(request, 'Invalid username or password', 401);
  }

  const salt = new Uint8Array(hexToArrayBuffer(user.salt));
  const computedHash = await hashPassword(body.password, salt);

  if (!(await timingSafeEqual(computedHash, user.password_hash))) {
    if (isRateLimitableIp(ip)) {
      const rl = await atomicIncrement(env.DB, rateLimitKey, 900);
      if (rl.count > 5) {
        logger.warn('auth.login.failure', { reason: 'rate_limited' });
        return rateLimitResponse(request, rl.windowStart, 900);
      }
    }
    logger.warn('auth.login.failure', { username: body.username, reason: 'wrong_password' });
    return errorResponse(request, 'Invalid username or password', 401);
  }

  // Reset failed login counter on successful authentication
  if (isRateLimitableIp(ip)) {
    await resetRateLimit(env.DB, rateLimitKey);
  }

  const token = await createToken(
    {
      sub: user.id,
      username: user.username,
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      token_version: user.token_version ?? 1,
    },
    env.JWT_SECRET,
  );

  logger.info('auth.login.success', { username: user.username, userId: user.id });
  const resp = new Response(JSON.stringify({ username: user.username }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request),
      'Set-Cookie': authCookieHeader(token, request),
    },
  });
  return resp;
}



async function handleMe(
  request: Request,
  env: Env,
  _logger: Logger,
): Promise<Response> {
  const payload = await authenticate(request, env);
  if (!payload) return errorResponse(request, 'Unauthorized', 401);
  return jsonResponse(request, { username: payload.username, userId: payload.sub });
}

async function handleGetPreferences(
  request: Request,
  env: Env,
  _logger: Logger,
): Promise<Response> {
  const payload = await authenticate(request, env);
  if (!payload) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  const prefs = await env.DB.prepare(
    'SELECT category_scores, hidden_categories, settings FROM preferences WHERE user_id = ?',
  )
    .bind(payload.sub)
    .first<Pick<PreferencesRow, 'category_scores' | 'hidden_categories' | 'settings'>>();

  if (!prefs) {
    return jsonResponse(request, { categoryScores: {}, hiddenCategories: [], settings: {} });
  }

  try {
    return jsonResponse(request, {
      categoryScores: JSON.parse(prefs.category_scores),
      hiddenCategories: JSON.parse(prefs.hidden_categories),
      settings: JSON.parse(prefs.settings || '{}'),
    });
  } catch {
    return jsonResponse(request, { categoryScores: {}, hiddenCategories: [], settings: {} });
  }
}

async function handlePutPreferences(
  request: Request,
  env: Env,
  logger: Logger,
): Promise<Response> {
  const payload = await authenticate(request, env);
  if (!payload) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  let body: { categoryScores?: unknown; hiddenCategories?: unknown; algorithmAggressiveness?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse(request, 'Invalid JSON body', 400);
  }

  if (body.categoryScores && (typeof body.categoryScores !== 'object' || Array.isArray(body.categoryScores))) {
    return errorResponse(request, 'categoryScores must be an object', 400);
  }
  if (body.hiddenCategories && !Array.isArray(body.hiddenCategories)) {
    return errorResponse(request, 'hiddenCategories must be an array', 400);
  }

  // Validate categoryScores values are numbers (prevents storing arbitrary data)
  if (body.categoryScores) {
    for (const [key, value] of Object.entries(body.categoryScores as Record<string, unknown>)) {
      if (typeof key !== 'string') {
        return errorResponse(request, 'categoryScores keys must be strings', 400);
      }
      if (typeof value !== 'number' || !Number.isFinite(value as number)) {
        return errorResponse(request, 'categoryScores values must be finite numbers', 400);
      }
    }
  }

  // Validate hiddenCategories items are strings
  if (body.hiddenCategories) {
    for (const item of body.hiddenCategories as unknown[]) {
      if (typeof item !== 'string') {
        return errorResponse(request, 'hiddenCategories items must be strings', 400);
      }
    }
  }

  // Build settings object from known client-sent fields
  const settings: Record<string, unknown> = {};
  if (typeof body.algorithmAggressiveness === 'number') {
    if (!Number.isFinite(body.algorithmAggressiveness)) {
      return errorResponse(request, 'algorithmAggressiveness must be a finite number', 400);
    }
    settings.algorithmAggressiveness = Math.max(0, Math.min(100, body.algorithmAggressiveness));
  }

  const categoryScores = JSON.stringify(body.categoryScores ?? {});
  const hiddenCategories = JSON.stringify(body.hiddenCategories ?? []);
  const settingsJson = JSON.stringify(settings);

  // Guard against excessively large payloads (1MB limit)
  if (categoryScores.length + hiddenCategories.length + settingsJson.length > 1_000_000) {
    return errorResponse(request, 'Preferences payload too large', 413);
  }

  await env.DB.prepare(
    `INSERT INTO preferences (user_id, category_scores, hidden_categories, settings, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       category_scores = excluded.category_scores,
       hidden_categories = excluded.hidden_categories,
       settings = excluded.settings,
       updated_at = excluded.updated_at`,
  )
    .bind(payload.sub, categoryScores, hiddenCategories, settingsJson)
    .run();

  logger.info('preferences.save', { userId: payload.sub });
  return jsonResponse(request, { success: true });
}

async function handleDeleteAccount(
  request: Request,
  env: Env,
  logger: Logger,
): Promise<Response> {
  const payload = await authenticate(request, env);
  if (!payload) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  // Rate limit: 5 delete attempts per user per day (prevents password brute-forcing)
  const deleteKey = `delete:${payload.sub}`;
  const rl = await atomicIncrement(env.DB, deleteKey, 86400);
  if (rl.count > 5) {
    return rateLimitResponse(request, rl.windowStart, 86400);
  }

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(request, 'Invalid JSON body', 400);
  }

  if (typeof body.password !== 'string' || !body.password) {
    return errorResponse(request, 'Password is required to delete account', 400);
  }

  // Verify password before deletion
  const user = await env.DB.prepare(
    'SELECT password_hash, salt FROM users WHERE id = ?',
  )
    .bind(payload.sub)
    .first<Pick<UserRow, 'password_hash' | 'salt'>>();

  if (!user) {
    logger.warn('auth.delete.failure', { userId: payload.sub, reason: 'user_not_found' });
    return errorResponse(request, 'User not found', 404);
  }

  const salt = new Uint8Array(hexToArrayBuffer(user.salt));
  const computedHash = await hashPassword(body.password, salt);

  if (!(await timingSafeEqual(computedHash, user.password_hash))) {
    logger.warn('auth.delete.failure', { userId: payload.sub, reason: 'wrong_password' });
    return errorResponse(request, 'Incorrect password', 403);
  }

  // Delete preferences first (foreign key), then user
  await env.DB.batch([
    env.DB.prepare('DELETE FROM preferences WHERE user_id = ?').bind(payload.sub),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(payload.sub),
  ]);

  logger.info('auth.delete.success', { userId: payload.sub, username: payload.username });
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request),
      'Set-Cookie': clearAuthCookieHeader(request),
    },
  });
}

async function handleLogout(
  request: Request,
  env: Env,
  logger: Logger,
): Promise<Response> {
  const payload = await authenticate(request, env);
  if (!payload) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  await env.DB.prepare(
    'UPDATE users SET token_version = token_version + 1 WHERE id = ?',
  ).bind(payload.sub).run();

  logger.info('auth.logout.success', { userId: payload.sub, username: payload.username });
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request),
      'Set-Cookie': clearAuthCookieHeader(request),
    },
  });
}

async function handleChangePassword(
  request: Request,
  env: Env,
  logger: Logger,
): Promise<Response> {
  const payload = await authenticate(request, env);
  if (!payload) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(request, 'Invalid JSON body', 400);
  }

  if (typeof body.currentPassword !== 'string' || !body.currentPassword) {
    return errorResponse(request, 'Current password is required', 400);
  }
  if (typeof body.newPassword !== 'string') {
    return errorResponse(request, 'New password is required', 400);
  }
  const validationError = validatePassword(body.newPassword);
  if (validationError) {
    return errorResponse(request, validationError, 400);
  }

  const user = await env.DB.prepare(
    'SELECT password_hash, salt FROM users WHERE id = ?',
  ).bind(payload.sub).first<Pick<UserRow, 'password_hash' | 'salt'>>();

  if (!user) {
    return errorResponse(request, 'User not found', 404);
  }

  const salt = new Uint8Array(hexToArrayBuffer(user.salt));
  const computedHash = await hashPassword(body.currentPassword, salt);

  if (!(await timingSafeEqual(computedHash, user.password_hash))) {
    logger.warn('auth.changePassword.failure', { userId: payload.sub, reason: 'wrong_password' });
    return errorResponse(request, 'Incorrect current password', 403);
  }

  const newSalt = generateSalt();
  const newHash = await hashPassword(body.newPassword, newSalt);
  const newSaltHex = arrayBufferToHex(newSalt.buffer as ArrayBuffer);

  // Update password AND increment token_version to invalidate all existing sessions
  await env.DB.prepare(
    'UPDATE users SET password_hash = ?, salt = ?, token_version = token_version + 1 WHERE id = ?',
  ).bind(newHash, newSaltHex, payload.sub).run();

  logger.info('auth.changePassword.success', { userId: payload.sub });
  return jsonResponse(request, { success: true });
}

// ─── Health Check ────────────────────────────────────────────────────

async function handleHealth(
  request: Request,
  env: Env,
  logger: Logger,
): Promise<Response> {
  const checks: Record<string, 'ok' | 'error'> = {};

  // Check D1 connectivity
  try {
    await env.DB.prepare('SELECT 1').first();
    checks.database = 'ok';
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('health.db.error', { error: msg });
    checks.database = 'error';
  }

  // Check R2 connectivity
  try {
    await env.DATA_BUCKET.head('smoldata.json');
    checks.storage = 'ok';
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('health.r2.error', { error: msg });
    checks.storage = 'error';
  }

  const healthy = Object.values(checks).every((v) => v === 'ok');

  return jsonResponse(request, {
    status: healthy ? 'healthy' : 'degraded',
    checks,
  }, healthy ? 200 : 503);
}

// ─── API Route Map ──────────────────────────────────────────────────

type ApiHandler = (req: Request, env: Env, log: Logger) => Promise<Response>;

// Null-prototype objects prevent prototype pollution (e.g., "constructor" method)
export const API_ROUTES: Record<string, Record<string, ApiHandler>> = Object.create(null);
let apiRoutesInitialized = false;

// Populated after handler definitions above
export function initApiRoutes(): void {
  const route = (handlers: Record<string, ApiHandler>): Record<string, ApiHandler> =>
    Object.assign(Object.create(null), handlers);

  API_ROUTES['/api/health'] = route({ GET: handleHealth });
  API_ROUTES['/api/register'] = route({ POST: handleRegister });
  API_ROUTES['/api/login'] = route({ POST: handleLogin });
  API_ROUTES['/api/logout'] = route({ POST: handleLogout });
  API_ROUTES['/api/me'] = route({ GET: handleMe });
  API_ROUTES['/api/preferences'] = route({ GET: handleGetPreferences, PUT: handlePutPreferences });
  API_ROUTES['/api/account'] = route({ DELETE: handleDeleteAccount });
  API_ROUTES['/api/password'] = route({ POST: handleChangePassword });
  apiRoutesInitialized = true;
}

export { apiRoutesInitialized };
