/**
 * Auth API client — registration, login, OAuth, tenants.
 */

const AUTH_BASE = '/auth';
const TENANT_BASE = '/tenants';

// === Token storage ===

const ACCESS_KEY = 'da_access_token';
const REFRESH_KEY = 'da_refresh_token';

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setTokens(access: string, refresh: string) {
  localStorage.setItem(ACCESS_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

// === Auth header helper ===

function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// === Types ===

export interface UserProfile {
  id: string;
  email: string | null;
  phone: string | null;
  username: string;
  avatar_url: string | null;
  is_verified: boolean;
  active_tenant_id: string | null;
  created_at: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export interface OAuthBinding {
  provider: string;
  provider_username: string | null;
  provider_avatar: string | null;
  bound_at: number;
}

export interface TenantInfo {
  id: string;
  name: string;
  slug: string;
  plan: string;
  member_count: number;
}

export interface MemberInfo {
  user_id: string;
  username: string;
  role: string;
  joined_at: number;
}

// === Auth API ===

export async function register(email: string, password: string, username?: string): Promise<TokenResponse> {
  const res = await fetch(`${AUTH_BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, username }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail?.message || '注册失败');
  setTokens(data.access_token, data.refresh_token);
  return data;
}

export async function login(email: string, password: string): Promise<TokenResponse> {
  const res = await fetch(`${AUTH_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail?.message || '登录失败');
  setTokens(data.access_token, data.refresh_token);
  return data;
}

export async function logout(): Promise<void> {
  const refresh = getRefreshToken();
  if (refresh) {
    await fetch(`${AUTH_BASE}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    });
  }
  clearTokens();
}

export async function getMe(): Promise<UserProfile> {
  const res = await fetch(`${AUTH_BASE}/me`, { headers: authHeaders() });
  if (!res.ok) throw new Error('获取用户信息失败');
  return res.json();
}

export async function updateMe(data: { username?: string; avatar_url?: string; password?: string }): Promise<UserProfile> {
  const res = await fetch(`${AUTH_BASE}/me`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('更新失败');
  return res.json();
}

export async function getBindings(): Promise<OAuthBinding[]> {
  const res = await fetch(`${AUTH_BASE}/me/bindings`, { headers: authHeaders() });
  if (!res.ok) throw new Error('获取绑定列表失败');
  return res.json();
}

export async function getOAuthUrl(provider: 'wechat' | 'github'): Promise<{ url: string; state: string }> {
  const res = await fetch(`${AUTH_BASE}/oauth/${provider}/url`);
  if (!res.ok) throw new Error('获取 OAuth URL 失败');
  return res.json();
}

export async function oauthLogin(provider: 'wechat' | 'github', code: string): Promise<TokenResponse> {
  const res = await fetch(`${AUTH_BASE}/oauth/${provider}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail?.message || 'OAuth 登录失败');
  setTokens(data.access_token, data.refresh_token);
  return data;
}

export async function bindOAuth(provider: 'wechat' | 'github', code: string): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/bind/${provider}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error('绑定失败');
}

export async function unbindOAuth(provider: 'wechat' | 'github'): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/bind/${provider}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error('解绑失败');
}

export async function refreshToken(): Promise<TokenResponse | null> {
  const refresh = getRefreshToken();
  if (!refresh) return null;

  const res = await fetch(`${AUTH_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (!res.ok) {
    clearTokens();
    return null;
  }
  const data = await res.json();
  setTokens(data.access_token, data.refresh_token);
  return data;
}

// === Tenant API ===

export async function createTenant(name: string, slug: string, plan = 'free'): Promise<TenantInfo> {
  const res = await fetch(`${TENANT_BASE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name, slug, plan }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail?.message || '创建租户失败');
  return data;
}

export async function getTenants(): Promise<TenantInfo[]> {
  const res = await fetch(`${TENANT_BASE}`, { headers: authHeaders() });
  if (!res.ok) throw new Error('获取租户列表失败');
  return res.json();
}

export async function switchTenant(tenantId: string): Promise<TokenResponse> {
  const res = await fetch(`${TENANT_BASE}/${tenantId}/switch`, {
    method: 'POST',
    headers: authHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('切换租户失败');
  if (data.access_token) {
    setTokens(data.access_token, data.refresh_token);
  }
  return data;
}

export async function getTenantMembers(tenantId: string): Promise<MemberInfo[]> {
  const res = await fetch(`${TENANT_BASE}/${tenantId}/members`, { headers: authHeaders() });
  if (!res.ok) throw new Error('获取成员列表失败');
  return res.json();
}

// === Auth state check ===

export function isLoggedIn(): boolean {
  return !!getAccessToken();
}
