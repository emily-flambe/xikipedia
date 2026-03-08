/**
 * Xikipedia Cloudflare Worker
 *
 * Serves static assets, proxies the large data file from R2 storage,
 * and provides user authentication + preferences API.
 */

export interface Env {
  DATA_BUCKET: R2Bucket;
  DB: D1Database;
  JWT_SECRET: string;
}

// ─── Types ───────────────────────────────────────────────────────────

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  salt: string;
  created_at: string;
}

interface PreferencesRow {
  user_id: number;
  category_scores: string;
  hidden_categories: string;
  updated_at: string;
}

interface TokenPayload {
  sub: number;
  username: string;
  exp: number;
}

// ─── Database Initialization ─────────────────────────────────────────

let tablesInitialized = false;

async function ensureTables(db: D1Database): Promise<void> {
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
    db.prepare(`CREATE TABLE IF NOT EXISTS rate_limit_events (
      key TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_rate_limit_events ON rate_limit_events (key, timestamp)`),
  ]);
  tablesInitialized = true;
}

// ─── Crypto Helpers ──────────────────────────────────────────────────

function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}

async function hashPassword(
  password: string,
  salt: Uint8Array,
): Promise<string> {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    passwordKey,
    256,
  );

  return arrayBufferToHex(derivedBits);
}

function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const encoder = new TextEncoder();
  const hmac1 = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(a)));
  const hmac2 = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(b)));
  let match = hmac1.length === hmac2.length;
  for (let i = 0; i < hmac1.length; i++) {
    match = match && hmac1[i] === hmac2[i];
  }
  return match;
}

// ─── Rate Limiting ────────────────────────────────────────────────────

function getClientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
         'unknown';
}

async function getRateLimitCount(
  db: D1Database,
  key: string,
  windowSeconds: number,
): Promise<number> {
  const windowStart = Math.floor(Date.now() / 1000) - windowSeconds;
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM rate_limit_events WHERE key = ? AND timestamp > ?')
    .bind(key, windowStart)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

async function recordRateLimitEvent(db: D1Database, key: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare('INSERT INTO rate_limit_events (key, timestamp) VALUES (?, ?)')
    .bind(key, now)
    .run();
  // Lazy cleanup: delete events older than 2 days
  await db
    .prepare('DELETE FROM rate_limit_events WHERE timestamp < ?')
    .bind(now - 2 * 24 * 60 * 60)
    .run();
}

async function getRetryAfter(
  db: D1Database,
  key: string,
  windowSeconds: number,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowSeconds;
  const oldest = await db
    .prepare('SELECT MIN(timestamp) as oldest FROM rate_limit_events WHERE key = ? AND timestamp > ?')
    .bind(key, windowStart)
    .first<{ oldest: number | null }>();
  if (oldest?.oldest == null) return windowSeconds;
  return Math.max(1, oldest.oldest + windowSeconds - now);
}

// ─── JWT Helpers ─────────────────────────────────────────────────────

async function getSigningKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function base64UrlEncode(data: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    bytes = data;
  }
  // Use btoa with binary string
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  // Restore standard base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function createToken(
  payload: TokenPayload,
  secret: string,
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getSigningKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput),
  );

  const signatureB64 = base64UrlEncode(signature);
  return `${signingInput}.${signatureB64}`;
}

async function verifyToken(
  token: string,
  secret: string,
): Promise<TokenPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const signingInput = `${headerB64}.${payloadB64}`;

    const key = await getSigningKey(secret);
    const signatureBytes = base64UrlDecode(signatureB64);

    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      new TextEncoder().encode(signingInput),
    );

    if (!valid) return null;

    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
    const payload: TokenPayload = JSON.parse(payloadJson);

    // Check expiration
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    // Invalid token format, base64 decode error, or JSON parse error
    return null;
  }
}

// ─── Response Helpers ────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://xiki.emilycogsdill.com',
  'https://xikipedia.emily-cogsdill.workers.dev',
];

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(
  request: Request,
  data: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request),
    },
  });
}

function errorResponse(request: Request, message: string, status: number): Response {
  return jsonResponse(request, { error: message }, status);
}

function rateLimitResponse(request: Request, retryAfter: number): Response {
  return new Response(JSON.stringify({ error: 'Too many requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter),
      ...getCorsHeaders(request),
    },
  });
}

// ─── Auth Middleware ─────────────────────────────────────────────────

async function authenticate(
  request: Request,
  secret: string,
): Promise<TokenPayload | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  return verifyToken(token, secret);
}

// ─── Validation ──────────────────────────────────────────────────────

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 256;

function validateRegistration(
  username: unknown,
  password: unknown,
): string | null {
  if (typeof username !== 'string' || typeof password !== 'string') {
    return 'Username and password are required';
  }
  if (!USERNAME_REGEX.test(username)) {
    return 'Username must be 3-20 characters, alphanumeric and underscores only';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return 'Password must be at least 6 characters';
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return 'Password must be at most 256 characters';
  }
  return null;
}

// ─── Route Handlers ─────────────────────────────────────────────────

async function handleRegister(
  request: Request,
  env: Env,
): Promise<Response> {
  const ip = getClientIp(request);
  const registerCount = await getRateLimitCount(env.DB, `register:${ip}`, 60 * 60);
  if (registerCount >= 3) {
    const retryAfter = await getRetryAfter(env.DB, `register:${ip}`, 60 * 60);
    return rateLimitResponse(request, retryAfter);
  }

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

    await recordRateLimitEvent(env.DB, `register:${ip}`);

    const userId = result.meta.last_row_id as number;

    const token = await createToken(
      {
        sub: userId,
        username,
        exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
      },
      env.JWT_SECRET,
    );

    return jsonResponse(request, { token, username }, 201);
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (errMsg.includes('UNIQUE constraint failed') || errMsg.includes('SQLITE_CONSTRAINT')) {
      return errorResponse(request, 'Username already taken', 409);
    }
    console.error('Registration error:', errMsg);
    return errorResponse(request, 'Registration failed', 500);
  }
}

async function handleLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  const ip = getClientIp(request);
  const failCount = await getRateLimitCount(env.DB, `login_fail:${ip}`, 15 * 60);
  if (failCount >= 5) {
    const retryAfter = await getRetryAfter(env.DB, `login_fail:${ip}`, 15 * 60);
    return rateLimitResponse(request, retryAfter);
  }

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
    'SELECT id, username, password_hash, salt FROM users WHERE username = ?',
  )
    .bind(body.username)
    .first<UserRow>();

  if (!user) {
    await recordRateLimitEvent(env.DB, `login_fail:${ip}`);
    return errorResponse(request, 'Invalid username or password', 401);
  }

  const salt = new Uint8Array(hexToArrayBuffer(user.salt));
  const computedHash = await hashPassword(body.password, salt);

  if (!(await timingSafeEqual(computedHash, user.password_hash))) {
    await recordRateLimitEvent(env.DB, `login_fail:${ip}`);
    return errorResponse(request, 'Invalid username or password', 401);
  }

  const token = await createToken(
    {
      sub: user.id,
      username: user.username,
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    },
    env.JWT_SECRET,
  );

  return jsonResponse(request, { token, username: user.username });
}

// Helper to verify user still exists (for deleted user token attacks)
async function userExists(db: D1Database, userId: number): Promise<boolean> {
  const user = await db.prepare('SELECT 1 FROM users WHERE id = ?').bind(userId).first();
  return !!user;
}

async function handleGetPreferences(
  request: Request,
  env: Env,
): Promise<Response> {
  const payload = await authenticate(request, env.JWT_SECRET);
  if (!payload) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  // Verify user still exists (token may be valid but user deleted)
  if (!(await userExists(env.DB, payload.sub))) {
    return errorResponse(request, 'User not found', 401);
  }

  const prefs = await env.DB.prepare(
    'SELECT category_scores, hidden_categories FROM preferences WHERE user_id = ?',
  )
    .bind(payload.sub)
    .first<Pick<PreferencesRow, 'category_scores' | 'hidden_categories'>>();

  if (!prefs) {
    return jsonResponse(request, { categoryScores: {}, hiddenCategories: [] });
  }

  try {
    return jsonResponse(request, {
      categoryScores: JSON.parse(prefs.category_scores),
      hiddenCategories: JSON.parse(prefs.hidden_categories),
    });
  } catch {
    return jsonResponse(request, { categoryScores: {}, hiddenCategories: [] });
  }
}

async function handlePutPreferences(
  request: Request,
  env: Env,
): Promise<Response> {
  const payload = await authenticate(request, env.JWT_SECRET);
  if (!payload) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  // Verify user still exists (token may be valid but user deleted)
  if (!(await userExists(env.DB, payload.sub))) {
    return errorResponse(request, 'User not found', 401);
  }

  let body: { categoryScores?: unknown; hiddenCategories?: unknown };
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

  const categoryScores = JSON.stringify(body.categoryScores ?? {});
  const hiddenCategories = JSON.stringify(body.hiddenCategories ?? []);

  // Guard against excessively large payloads (1MB limit)
  if (categoryScores.length + hiddenCategories.length > 1_000_000) {
    return errorResponse(request, 'Preferences payload too large', 413);
  }

  await env.DB.prepare(
    `INSERT INTO preferences (user_id, category_scores, hidden_categories, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       category_scores = excluded.category_scores,
       hidden_categories = excluded.hidden_categories,
       updated_at = excluded.updated_at`,
  )
    .bind(payload.sub, categoryScores, hiddenCategories)
    .run();

  return jsonResponse(request, { success: true });
}

async function handleDeleteAccount(
  request: Request,
  env: Env,
): Promise<Response> {
  const payload = await authenticate(request, env.JWT_SECRET);
  if (!payload) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  const deleteCount = await getRateLimitCount(env.DB, `delete_account:${payload.sub}`, 24 * 60 * 60);
  if (deleteCount >= 1) {
    const retryAfter = await getRetryAfter(env.DB, `delete_account:${payload.sub}`, 24 * 60 * 60);
    return rateLimitResponse(request, retryAfter);
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
    return errorResponse(request, 'User not found', 404);
  }

  const salt = new Uint8Array(hexToArrayBuffer(user.salt));
  const computedHash = await hashPassword(body.password, salt);

  if (!(await timingSafeEqual(computedHash, user.password_hash))) {
    return errorResponse(request, 'Incorrect password', 403);
  }

  await recordRateLimitEvent(env.DB, `delete_account:${payload.sub}`);

  // Delete preferences first (foreign key), then user
  await env.DB.batch([
    env.DB.prepare('DELETE FROM preferences WHERE user_id = ?').bind(payload.sub),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(payload.sub),
  ]);

  return jsonResponse(request, { success: true });
}

// ─── R2 File Serving Helper ──────────────────────────────────────────

async function serveR2File(
  env: Env,
  key: string,
  request: Request,
  options: { cacheControl: string; contentType: string }
): Promise<Response> {
  const object = await env.DATA_BUCKET.get(key);

  if (!object) {
    return new Response('File not found', { status: 404 });
  }

  const headers = new Headers();
  headers.set('Content-Type', options.contentType);
  headers.set('Cache-Control', options.cacheControl);
  headers.set('Access-Control-Allow-Origin', '*');

  // Handle range requests for streaming
  const range = request.headers.get('range');
  if (range) {
    const size = object.size;
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : size - 1;

    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    headers.set('Accept-Ranges', 'bytes');

    return new Response(object.body, {
      status: 206,
      headers,
    });
  }

  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

// ─── Environment Validation ──────────────────────────────────────────

function validateApiEnv(env: Env): string | null {
  if (!env.JWT_SECRET) {
    return 'JWT_SECRET is not configured';
  }
  if (env.JWT_SECRET.length < 32) {
    return 'JWT_SECRET must be at least 32 characters';
  }
  if (!env.DB) {
    return 'D1 database binding (DB) is not configured';
  }
  return null;
}

function validateR2Env(env: Env): string | null {
  if (!env.DATA_BUCKET) {
    return 'R2 bucket binding (DATA_BUCKET) is not configured';
  }
  return null;
}

// ─── Main Worker ─────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight for API routes
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(request),
      });
    }

    // API Routes
    if (url.pathname.startsWith('/api/')) {
      // Validate JWT_SECRET and DB before processing API requests
      const apiEnvError = validateApiEnv(env);
      if (apiEnvError) {
        console.error(`Environment validation failed: ${apiEnvError}`);
        return new Response('Server misconfigured', { status: 500 });
      }

      await ensureTables(env.DB);

      try {
        if (url.pathname === '/api/register' && request.method === 'POST') {
          return await handleRegister(request, env);
        }

        if (url.pathname === '/api/login' && request.method === 'POST') {
          return await handleLogin(request, env);
        }

        if (url.pathname === '/api/preferences' && request.method === 'GET') {
          return await handleGetPreferences(request, env);
        }

        if (url.pathname === '/api/preferences' && request.method === 'PUT') {
          return await handlePutPreferences(request, env);
        }

        if (url.pathname === '/api/account' && request.method === 'DELETE') {
          return await handleDeleteAccount(request, env);
        }

        return errorResponse(request, 'Not found', 404);
      } catch (e: unknown) {
        console.error('API error:', e instanceof Error ? e.message : String(e));
        return errorResponse(request, 'Internal server error', 500);
      }
    }

    // Validate R2 binding before serving data files
    const r2EnvError = validateR2Env(env);
    if (r2EnvError) {
      console.error(`Environment validation failed: ${r2EnvError}`);
      return new Response('Server misconfigured', { status: 500 });
    }

    // Handle index.json request - serve from R2
    if (url.pathname === '/index.json') {
      return serveR2File(env, 'index.json', request, {
        cacheControl: 'public, max-age=86400', // 1 day - may update with new articles
        contentType: 'application/json',
      });
    }

    // Handle article chunk requests - /articles/chunk-NNNNNN.json
    const chunkMatch = url.pathname.match(/^\/articles\/chunk-(\d{6})\.json$/);
    if (chunkMatch) {
      const chunkId = parseInt(chunkMatch[1], 10);
      // Validate chunk ID is in valid range (0-999, allowing room for growth)
      if (chunkId < 0 || chunkId > 999) {
        return new Response('Invalid chunk ID', { status: 400 });
      }
      const chunkKey = `articles/chunk-${chunkMatch[1]}.json`;
      return serveR2File(env, chunkKey, request, {
        cacheControl: 'public, max-age=604800, immutable', // 1 week, content rarely changes
        contentType: 'application/json',
      });
    }

    // Handle smoldata.json request - serve from R2
    if (url.pathname === '/smoldata.json') {
      return serveR2File(env, 'smoldata.json', request, {
        cacheControl: 'public, max-age=604800', // 1 week
        contentType: 'application/json',
      });
    }

    // All other requests are handled by Cloudflare's asset serving
    // (this code won't be reached for static assets when [assets] is configured)
    return new Response('Not Found', { status: 404 });
  },
};
