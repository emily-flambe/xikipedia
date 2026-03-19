/**
 * Authentication: password hashing, JWT tokens, cookies, and middleware.
 */

import type { Env } from './index';

// ─── Types ───────────────────────────────────────────────────────────

export interface TokenPayload {
  sub: number;
  username: string;
  exp: number;
  token_version?: number; // optional for legacy tokens issued before revocation support
}

// ─── Crypto Helpers ──────────────────────────────────────────────────

export function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}

export async function hashPassword(
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

export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
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

export async function createToken(
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

export async function verifyToken(
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

// ─── Cookie Helpers ──────────────────────────────────────────────────

export function getTokenFromCookies(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(';')) {
    const [name, ...rest] = cookie.trim().split('=');
    if (name.trim() === 'xiki_token') return rest.join('=').trim();
  }
  return null;
}

export function authCookieHeader(token: string, request?: Request): string {
  const maxAge = 30 * 24 * 60 * 60;
  const secure = !request || new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `xiki_token=${token}; HttpOnly${secure}; SameSite=Strict; Max-Age=${maxAge}; Path=/api`;
}

export function clearAuthCookieHeader(request?: Request): string {
  const secure = !request || new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `xiki_token=; HttpOnly${secure}; SameSite=Strict; Max-Age=0; Path=/api`;
}

// ─── Auth Middleware ─────────────────────────────────────────────────

export async function authenticate(
  request: Request,
  env: Env,
): Promise<TokenPayload | null> {
  const cookieToken = getTokenFromCookies(request);
  if (!cookieToken) return null;

  const payload = await verifyToken(cookieToken, env.JWT_SECRET);
  if (!payload) return null;

  // Verify token_version matches DB to support revocation
  const row = await env.DB.prepare(
    'SELECT token_version FROM users WHERE id = ?',
  ).bind(payload.sub).first<{ token_version: number }>();
  if (!row) return null;
  const currentVersion = row.token_version ?? 1;
  const payloadVersion = payload.token_version ?? 1;
  if (payloadVersion !== currentVersion) return null;

  return payload;
}

// ─── Validation ──────────────────────────────────────────────────────

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 256;

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') {
    return 'Password is required';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return 'Password must be at least 6 characters';
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return 'Password must be at most 256 characters';
  }
  return null;
}

export function validateRegistration(
  username: unknown,
  password: unknown,
): string | null {
  if (typeof username !== 'string' || typeof password !== 'string') {
    return 'Username and password are required';
  }
  if (!USERNAME_REGEX.test(username)) {
    return 'Username must be 3-20 characters, alphanumeric and underscores only';
  }
  return validatePassword(password);
}
