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

let currentRequest: Request | null = null;

function jsonResponse(
  data: unknown,
  status = 200,
): Response {
  const cors = currentRequest ? getCorsHeaders(currentRequest) : { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] };
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...cors,
    },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
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
  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const validationError = validateRegistration(body.username, body.password);
  if (validationError) {
    return errorResponse(validationError, 400);
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
      },
      env.JWT_SECRET,
    );

    return jsonResponse({ token, username }, 201);
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (errMsg.includes('UNIQUE constraint failed') || errMsg.includes('SQLITE_CONSTRAINT')) {
      return errorResponse('Username already taken', 409);
    }
    console.error('Registration error:', errMsg);
    return errorResponse('Registration failed', 500);
  }
}

async function handleLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (typeof body.username !== 'string' || typeof body.password !== 'string') {
    return errorResponse('Username and password are required', 400);
  }

  const user = await env.DB.prepare(
    'SELECT id, username, password_hash, salt FROM users WHERE username = ?',
  )
    .bind(body.username)
    .first<UserRow>();

  if (!user) {
    return errorResponse('Invalid username or password', 401);
  }

  const salt = new Uint8Array(hexToArrayBuffer(user.salt));
  const computedHash = await hashPassword(body.password, salt);

  // Timing-safe comparison via HMAC: compute HMAC of both hashes and compare
  const compKey = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const hmac1 = new Uint8Array(await crypto.subtle.sign('HMAC', compKey, new TextEncoder().encode(computedHash)));
  const hmac2 = new Uint8Array(await crypto.subtle.sign('HMAC', compKey, new TextEncoder().encode(user.password_hash)));
  let match = hmac1.length === hmac2.length;
  for (let i = 0; i < hmac1.length; i++) {
    match = match && hmac1[i] === hmac2[i];
  }
  if (!match) {
    return errorResponse('Invalid username or password', 401);
  }

  const token = await createToken(
    {
      sub: user.id,
      username: user.username,
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    },
    env.JWT_SECRET,
  );

  return jsonResponse({ token, username: user.username });
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
    return errorResponse('Unauthorized', 401);
  }

  // Verify user still exists (token may be valid but user deleted)
  if (!(await userExists(env.DB, payload.sub))) {
    return errorResponse('User not found', 401);
  }

  const prefs = await env.DB.prepare(
    'SELECT category_scores, hidden_categories FROM preferences WHERE user_id = ?',
  )
    .bind(payload.sub)
    .first<Pick<PreferencesRow, 'category_scores' | 'hidden_categories'>>();

  if (!prefs) {
    return jsonResponse({ categoryScores: {}, hiddenCategories: [] });
  }

  try {
    return jsonResponse({
      categoryScores: JSON.parse(prefs.category_scores),
      hiddenCategories: JSON.parse(prefs.hidden_categories),
    });
  } catch {
    return jsonResponse({ categoryScores: {}, hiddenCategories: [] });
  }
}

async function handlePutPreferences(
  request: Request,
  env: Env,
): Promise<Response> {
  const payload = await authenticate(request, env.JWT_SECRET);
  if (!payload) {
    return errorResponse('Unauthorized', 401);
  }

  // Verify user still exists (token may be valid but user deleted)
  if (!(await userExists(env.DB, payload.sub))) {
    return errorResponse('User not found', 401);
  }

  let body: { categoryScores?: unknown; hiddenCategories?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (body.categoryScores && (typeof body.categoryScores !== 'object' || Array.isArray(body.categoryScores))) {
    return errorResponse('categoryScores must be an object', 400);
  }
  if (body.hiddenCategories && !Array.isArray(body.hiddenCategories)) {
    return errorResponse('hiddenCategories must be an array', 400);
  }

  const categoryScores = JSON.stringify(body.categoryScores ?? {});
  const hiddenCategories = JSON.stringify(body.hiddenCategories ?? []);

  // Guard against excessively large payloads (1MB limit)
  if (categoryScores.length + hiddenCategories.length > 1_000_000) {
    return errorResponse('Preferences payload too large', 413);
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

  return jsonResponse({ success: true });
}

async function handleDeleteAccount(
  request: Request,
  env: Env,
): Promise<Response> {
  const payload = await authenticate(request, env.JWT_SECRET);
  if (!payload) {
    return errorResponse('Unauthorized', 401);
  }

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (typeof body.password !== 'string' || !body.password) {
    return errorResponse('Password is required to delete account', 400);
  }

  // Verify password before deletion
  const user = await env.DB.prepare(
    'SELECT password_hash, salt FROM users WHERE id = ?',
  )
    .bind(payload.sub)
    .first<Pick<UserRow, 'password_hash' | 'salt'>>();

  if (!user) {
    return errorResponse('User not found', 404);
  }

  const salt = new Uint8Array(hexToArrayBuffer(user.salt));
  const computedHash = await hashPassword(body.password, salt);

  if (computedHash !== user.password_hash) {
    return errorResponse('Incorrect password', 403);
  }

  // Delete preferences first (foreign key), then user
  await env.DB.batch([
    env.DB.prepare('DELETE FROM preferences WHERE user_id = ?').bind(payload.sub),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(payload.sub),
  ]);

  return jsonResponse({ success: true });
}

// ─── Main Worker ─────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    currentRequest = request;
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

        return errorResponse('Not found', 404);
      } catch (e: unknown) {
        console.error('API error:', e instanceof Error ? e.message : String(e));
        return errorResponse('Internal server error', 500);
      }
    }

    // Handle smoldata.json request - serve from R2
    if (url.pathname === '/smoldata.json') {
      const object = await env.DATA_BUCKET.get('smoldata.json');

      if (!object) {
        return new Response('Data file not found', { status: 404 });
      }

      const headers = new Headers();
      headers.set('Content-Type', 'application/json');
      headers.set('Cache-Control', 'public, max-age=604800'); // Cache for 1 week
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

        // Slice the body for range request
        const body = object.body;
        return new Response(body, {
          status: 206,
          headers,
        });
      }

      headers.set('Content-Length', String(object.size));
      return new Response(object.body, { headers });
    }

    // All other requests are handled by Cloudflare's asset serving
    // (this code won't be reached for static assets when [assets] is configured)
    return new Response('Not Found', { status: 404 });
  },
};
