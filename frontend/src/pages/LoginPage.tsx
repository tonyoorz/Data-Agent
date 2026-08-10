/**
 * Login / Register page with WeChat QR + GitHub OAuth.
 */

import React, { useState, useEffect } from 'react';
import { Card, Tabs, Form, Input, Button, Typography, Divider, Space, Alert, Spin } from 'antd';
import { GithubOutlined, QrcodeOutlined, MailOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../components/AuthContext';
import { getOAuthUrl } from '../api/auth';
import { useNavigate, useLocation } from 'react-router-dom';

const { Title, Text, Link } = Typography;

const LoginPage: React.FC = () => {
  const { login, register, oauthLogin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');

  // OAuth state
  const [wechatUrl, setWechatUrl] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [oauthLoading, setOauthLoading] = useState(false);

  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/';

  // Load OAuth URLs on mount
  useEffect(() => {
    loadOAuthUrls();
    // Check for OAuth callback (code in URL)
    checkOAuthCallback();
  }, []);

  async function loadOAuthUrls() {
    setOauthLoading(true);
    try {
      const [wx, gh] = await Promise.allSettled([
        getOAuthUrl('wechat'),
        getOAuthUrl('github'),
      ]);
      if (wx.status === 'fulfilled') setWechatUrl(wx.value.url);
      if (gh.status === 'fulfilled') setGithubUrl(gh.value.url);
    } catch {
      // OAuth not configured yet
    }
    setOauthLoading(false);
  }

  async function checkOAuthCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const provider = params.get('provider') || (state?.includes('gh') ? 'github' : 'wechat');

    if (code) {
      setLoading(true);
      setError('');
      try {
        await oauthLogin(provider as 'wechat' | 'github', code);
        // Clean URL
        window.history.replaceState({}, '', '/');
        navigate(from);
      } catch (e: any) {
        setError(e.message || 'OAuth 登录失败');
      } finally {
        setLoading(false);
      }
    }
  }

  async function handleSubmit(values: { email: string; password: string; username?: string }) {
    setLoading(true);
    setError('');
    try {
      if (mode === 'login') {
        await login(values.email, values.password);
      } else {
        await register(values.email, values.password, values.username);
      }
      navigate(from);
    } catch (e: any) {
      setError(e.message || '操作失败');
    } finally {
      setLoading(false);
    }
  }

  function handleGitHubLogin() {
    if (githubUrl) {
      // Append provider hint to redirect URI for callback detection
      const sep = githubUrl.includes('&') ? '&' : '?';
      window.location.href = githubUrl + `${sep}provider=github`;
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    }}>
      <Card style={{ width: 420, boxShadow: '0 8px 40px rgba(0,0,0,0.12)' }} bordered={false}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Title level={3} style={{ marginBottom: 4 }}>Data-Agent</Title>
          <Text type="secondary">智能数据分析平台</Text>
        </div>

        {error && <Alert message={error} type="error" showIcon closable onClose={() => setError('')} style={{ marginBottom: 16 }} />}

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin size="large" />
            <p style={{ marginTop: 16, color: '#999' }}>登录中...</p>
          </div>
        ) : (
          <>
            <Tabs
              activeKey={mode}
              onChange={(k) => setMode(k as 'login' | 'register')}
              centered
              items={[
                {
                  key: 'login',
                  label: '登录',
                  children: (
                    <Form onFinish={handleSubmit} size="large" autoComplete="off">
                      <Form.Item name="email" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}>
                        <Input prefix={<MailOutlined />} placeholder="邮箱" />
                      </Form.Item>
                      <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }, { min: 6, message: '至少 6 位' }]}>
                        <Input.Password prefix={<LockOutlined />} placeholder="密码" />
                      </Form.Item>
                      <Button type="primary" htmlType="submit" block loading={loading}>
                        登录
                      </Button>
                    </Form>
                  ),
                },
                {
                  key: 'register',
                  label: '注册',
                  children: (
                    <Form onFinish={handleSubmit} size="large" autoComplete="off">
                      <Form.Item name="username" rules={[{ min: 2, message: '至少 2 个字符' }]}>
                        <Input prefix={<UserOutlined />} placeholder="用户名（可选）" />
                      </Form.Item>
                      <Form.Item name="email" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}>
                        <Input prefix={<MailOutlined />} placeholder="邮箱" />
                      </Form.Item>
                      <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }, { min: 6, message: '至少 6 位' }]}>
                        <Input.Password prefix={<LockOutlined />} placeholder="密码（至少 6 位）" />
                      </Form.Item>
                      <Button type="primary" htmlType="submit" block loading={loading}>
                        注册
                      </Button>
                    </Form>
                  ),
                },
              ]}
            />

            {/* OAuth Section */}
            <Divider plain style={{ margin: '20px 0' }}>
              <Text type="secondary" style={{ fontSize: 13 }}>第三方登录</Text>
            </Divider>

            {oauthLoading ? (
              <div style={{ textAlign: 'center', padding: 16 }}>
                <Spin />
              </div>
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size={12}>
                {/* WeChat QR */}
                {wechatUrl && (
                  <div style={{ textAlign: 'center' }}>
                    <Button
                      icon={<QrcodeOutlined />}
                      block
                      size="large"
                      onClick={() => window.open(wechatUrl, '_blank', 'width=600,height=500')}
                      style={{ background: '#07c160', borderColor: '#07c160', color: '#fff' }}
                    >
                      微信扫码登录
                    </Button>
                  </div>
                )}

                {/* GitHub */}
                {githubUrl && (
                  <Button
                    icon={<GithubOutlined />}
                    block
                    size="large"
                    onClick={handleGitHubLogin}
                    style={{ background: '#24292f', borderColor: '#24292f', color: '#fff' }}
                  >
                    GitHub 登录
                  </Button>
                )}

                {!wechatUrl && !githubUrl && (
                  <Text type="secondary" style={{ display: 'block', textAlign: 'center', fontSize: 13 }}>
                    第三方登录需配置 OAuth App
                  </Text>
                )}
              </Space>
            )}
          </>
        )}
      </Card>
    </div>
  );
};

export default LoginPage;
