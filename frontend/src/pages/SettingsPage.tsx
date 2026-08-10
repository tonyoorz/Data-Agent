/**
 * Settings page — profile, OAuth bindings, tenant management.
 */

import React, { useState, useEffect } from 'react';
import { Card, Tabs, Form, Input, Button, Avatar, List, Tag, Space, message, Modal, Table, Select, Popconfirm, Typography } from 'antd';
import { UserOutlined, GithubOutlined, QrcodeOutlined, PlusOutlined, DeleteOutlined, TeamOutlined } from '@ant-design/icons';
import { useAuth } from '../components/AuthContext';
import * as authApi from '../api/auth';
import type { OAuthBinding, TenantInfo, MemberInfo } from '../api/auth';

const { Text } = Typography;

const SettingsPage: React.FC = () => {
  const { user, logout, refreshUser } = useAuth();
  const [profileForm] = Form.useForm();
  const [savingProfile, setSavingProfile] = useState(false);
  const [bindings, setBindings] = useState<OAuthBinding[]>([]);
  const [tenants, setTenants] = useState<TenantInfo[]>([]);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<TenantInfo | null>(null);
  const [showCreateTenant, setShowCreateTenant] = useState(false);

  useEffect(() => {
    if (user) {
      profileForm.setFieldsValue({ username: user.username, avatar_url: user.avatar_url });
      loadBindings();
      loadTenants();
    }
  }, [user]);

  async function loadBindings() {
    try {
      const data = await authApi.getBindings();
      setBindings(data);
    } catch { /* ignore */ }
  }

  async function loadTenants() {
    try {
      const data = await authApi.getTenants();
      setTenants(data);
      if (data.length > 0 && user?.active_tenant_id) {
        const active = data.find(t => t.id === user.active_tenant_id);
        if (active) {
          setSelectedTenant(active);
          loadMembers(active.id);
        }
      }
    } catch { /* ignore */ }
  }

  async function loadMembers(tenantId: string) {
    try {
      const data = await authApi.getTenantMembers(tenantId);
      setMembers(data);
    } catch { /* ignore */ }
  }

  async function saveProfile(values: { username: string; avatar_url?: string; password?: string }) {
    setSavingProfile(true);
    try {
      await authApi.updateMe(values);
      await refreshUser();
      message.success('保存成功');
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleUnbind(provider: string) {
    try {
      await authApi.unbindOAuth(provider as 'wechat' | 'github');
      message.success(`已解绑 ${provider}`);
      loadBindings();
    } catch (e: any) {
      message.error(e.message);
    }
  }

  async function handleSwitchTenant(tenantId: string) {
    try {
      await authApi.switchTenant(tenantId);
      await refreshUser();
      const t = tenants.find(x => x.id === tenantId);
      if (t) {
        setSelectedTenant(t);
        loadMembers(tenantId);
      }
      message.success('已切换租户');
    } catch (e: any) {
      message.error(e.message);
    }
  }

  const roleColors: Record<string, string> = {
    owner: 'gold', admin: 'red', member: 'blue', viewer: 'default',
  };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <Card>
        <Tabs
          items={[
            {
              key: 'profile',
              label: '个人资料',
              children: (
                <>
                  <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 16 }}>
                    <Avatar size={64} src={user?.avatar_url} icon={<UserOutlined />} />
                    <div>
                      <h3 style={{ margin: 0 }}>{user?.username}</h3>
                      <span style={{ color: '#999' }}>{user?.email || '未设置邮箱'}</span>
                      {user?.is_verified && <Tag color="green" style={{ marginLeft: 8 }}>已验证</Tag>}
                    </div>
                  </div>

                  <Form form={profileForm} layout="vertical" onFinish={saveProfile} style={{ maxWidth: 400 }}>
                    <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
                      <Input prefix={<UserOutlined />} />
                    </Form.Item>
                    <Form.Item name="avatar_url" label="头像 URL">
                      <Input placeholder="https://..." />
                    </Form.Item>
                    <Form.Item name="password" label="新密码（留空不修改）">
                      <Input.Password placeholder="至少 6 位" />
                    </Form.Item>
                    <Form.Item>
                      <Space>
                        <Button type="primary" htmlType="submit" loading={savingProfile}>保存</Button>
                        <Button danger onClick={logout}>退出登录</Button>
                      </Space>
                    </Form.Item>
                  </Form>
                </>
              ),
            },
            {
              key: 'oauth',
              label: '第三方绑定',
              children: (
                <List
                  dataSource={[
                    { provider: 'wechat', label: '微信', icon: <QrcodeOutlined /> },
                    { provider: 'github', label: 'GitHub', icon: <GithubOutlined /> },
                  ]}
                  renderItem={(item) => {
                    const bound = bindings.find(b => b.provider === item.provider);
                    return (
                      <List.Item
                        actions={[
                          bound ? (
                            <Popconfirm
                              key="unbind"
                              title="确定解绑？"
                              onConfirm={() => handleUnbind(item.provider)}
                            >
                              <Button danger size="small" icon={<DeleteOutlined />}>解绑</Button>
                            </Popconfirm>
                          ) : (
                            <Button key="bind" size="small" type="link"
                              onClick={() => message.info('请使用第三方登录页面绑定')}>
                              去绑定
                            </Button>
                          ),
                        ]}
                      >
                        <List.Item.Meta
                          avatar={item.icon}
                          title={item.label}
                          description={bound ? `已绑定: ${bound.provider_username || 'N/A'}` : '未绑定'}
                        />
                      </List.Item>
                    );
                  }}
                />
              ),
            },
            {
              key: 'tenant',
              label: (
                <span><TeamOutlined /> 租户管理</span>
              ),
              children: (
                <>
                  <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text strong>当前租户: {selectedTenant?.name || '无'}</Text>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowCreateTenant(true)}>
                      新建租户
                    </Button>
                  </div>

                  <Table<TenantInfo>
                    dataSource={tenants}
                    rowKey="id"
                    pagination={false}
                    size="small"
                    columns={[
                      { title: '名称', dataIndex: 'name', key: 'name' },
                      { title: '标识', dataIndex: 'slug', key: 'slug' },
                      { title: '套餐', dataIndex: 'plan', key: 'plan', render: (p) => <Tag color="purple">{p}</Tag> },
                      { title: '成员', dataIndex: 'member_count', key: 'member_count' },
                      {
                        title: '操作', key: 'action',
                        render: (_, record) => (
                          <Space>
                            {user?.active_tenant_id === record.id ? (
                              <Tag color="green">当前</Tag>
                            ) : (
                              <Button size="small" onClick={() => handleSwitchTenant(record.id)}>切换</Button>
                            )}
                            <Button size="small" onClick={() => { setSelectedTenant(record); loadMembers(record.id); }}>
                              成员
                            </Button>
                          </Space>
                        ),
                      },
                    ]}
                  />

                  {selectedTenant && members.length > 0 && (
                    <Card title={`${selectedTenant.name} — 成员列表`} size="small" style={{ marginTop: 16 }}>
                      <Table<MemberInfo>
                        dataSource={members}
                        rowKey="user_id"
                        pagination={false}
                        size="small"
                        columns={[
                          { title: '用户', dataIndex: 'username', key: 'username' },
                          {
                            title: '角色', dataIndex: 'role', key: 'role',
                            render: (role) => <Tag color={roleColors[role] || 'default'}>{role}</Tag>,
                          },
                        ]}
                      />
                    </Card>
                  )}

                  <CreateTenantModal
                    visible={showCreateTenant}
                    onCancel={() => setShowCreateTenant(false)}
                    onSuccess={async () => {
                      setShowCreateTenant(false);
                      await loadTenants();
                    }}
                  />
                </>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};

// === Create Tenant Modal ===

const CreateTenantModal: React.FC<{
  visible: boolean;
  onCancel: () => void;
  onSuccess: () => void;
}> = ({ visible, onCancel, onSuccess }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    try {
      const values = await form.validateFields();
      setLoading(true);
      await authApi.createTenant(values.name, values.slug);
      message.success('租户创建成功');
      form.resetFields();
      onSuccess();
    } catch (e: any) {
      if (e.message) message.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal title="新建租户" open={visible} onCancel={onCancel} onOk={handleCreate} confirmLoading={loading}>
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="租户名称" rules={[{ required: true, message: '请输入名称' }]}>
          <Input placeholder="例如：我的团队" />
        </Form.Item>
        <Form.Item
          name="slug"
          label="URL 标识"
          rules={[
            { required: true, message: '请输入标识' },
            { pattern: /^[a-z0-9][a-z0-9-]*$/, message: '只允许小写字母、数字和连字符' },
          ]}
        >
          <Input placeholder="例如：my-team" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default SettingsPage;
