/**
 * Auth context — global auth state management.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { message } from 'antd';
import type { UserProfile } from '../api/auth';
import * as authApi from '../api/auth';

interface AuthContextValue {
  user: UserProfile | null;
  loading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, username?: string) => Promise<void>;
  oauthLogin: (provider: 'wechat' | 'github', code: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUser = useCallback(async () => {
    if (!authApi.isLoggedIn()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await authApi.getMe();
      setUser(me);
    } catch {
      // Try refresh
      const refreshed = await authApi.refreshToken();
      if (refreshed) {
        try {
          const me = await authApi.getMe();
          setUser(me);
        } catch {
          setUser(null);
        }
      } else {
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  const handleLogin = async (email: string, password: string) => {
    await authApi.login(email, password);
    const me = await authApi.getMe();
    setUser(me);
    message.success(`欢迎回来，${me.username}！`);
  };

  const handleRegister = async (email: string, password: string, username?: string) => {
    await authApi.register(email, password, username);
    const me = await authApi.getMe();
    setUser(me);
    message.success(`注册成功，欢迎 ${me.username}！`);
  };

  const handleOAuthLogin = async (provider: 'wechat' | 'github', code: string) => {
    await authApi.oauthLogin(provider, code);
    const me = await authApi.getMe();
    setUser(me);
    message.success(`登录成功，欢迎 ${me.username}！`);
  };

  const handleLogout = async () => {
    await authApi.logout();
    setUser(null);
    message.success('已退出登录');
  };

  const refreshUser = async () => {
    const me = await authApi.getMe();
    setUser(me);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAuthenticated: !!user,
        login: handleLogin,
        register: handleRegister,
        oauthLogin: handleOAuthLogin,
        logout: handleLogout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
