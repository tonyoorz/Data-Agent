/** AIChatPage — 主聊天页面 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Card, Input, Button, Space, Typography, Avatar, Spin, Empty, Divider, Tooltip,
  Dropdown, Tag,
} from 'antd';
import {
  SendOutlined, RobotOutlined, UserOutlined, DatabaseOutlined,
  ClockCircleOutlined, ReloadOutlined, HistoryOutlined,
  SettingOutlined, LogoutOutlined, TeamOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { ChatMessage } from '../types';
import { query, getHistory } from '../api/client';
import { useAuth } from '../components/AuthContext';
import AgentStepDisplay from '../components/AgentStepDisplay';
import StoryCard from '../components/StoryCard';
import FeedbackButtons from '../components/FeedbackButtons';
import ChartRenderer from '../components/ChartRenderer';
import StatsPanel from './StatsPanel';

const { TextArea } = Input;
const { Text } = Typography;

const SUGGESTIONS = [
  'IDCEVO 有多少 Critical 缺陷？',
  '缺陷按项目分布',
  'BCM 相关缺陷趋势',
  '缺陷最多的 TOP 5 ECU',
  '当前仪表盘汇总',
];

const AIChatPage: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'stats' | 'history'>('chat');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async (text?: string) => {
    const question = text || input.trim();
    if (!question) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: question,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const resp = await query(question, true);
      const aiMsg: ChatMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: resp.answer,
        response: resp,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (err) {
      setMessages((prev) => [...prev, {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: `查询失败: ${err instanceof Error ? err.message : '未知错误'}`,
        timestamp: Date.now(),
      }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top Bar with User Info */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '0 20px', height: 48, background: '#fff',
        borderBottom: '1px solid #f0f0f0', flexShrink: 0,
      }}>
        <Space>
          <RobotOutlined style={{ fontSize: 18, color: '#1677ff' }} />
          <Text strong>Data-Agent</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>智能数据分析平台</Text>
        </Space>
        <Dropdown menu={{
          items: [
            { key: 'settings', label: '设置', icon: <SettingOutlined /> },
            { type: 'divider' as const },
            { key: 'logout', label: '退出登录', icon: <LogoutOutlined />, danger: true },
          ],
          onClick: ({ key }) => {
            if (key === 'settings') navigate('/settings');
            else if (key === 'logout') { logout(); navigate('/login'); }
          },
        }}>
          <Space style={{ cursor: 'pointer' }}>
            <Avatar size="small" src={user?.avatar_url} icon={<UserOutlined />} />
            <Text style={{ fontSize: 13 }}>{user?.username || 'User'}</Text>
          </Space>
        </Dropdown>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', gap: 16, padding: 16, overflow: 'hidden' }}>
      {/* Main Chat Area */}
      <Card
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 16 } }}
        title={
          <Space>
            <RobotOutlined />
            <span>Data-Agent 智能分析</span>
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
              Ontology-driven NL→SQL Agent
            </Text>
          </Space>
        }
        extra={
          <Space>
            <Tooltip title="对话">
              <Button
                type={activeTab === 'chat' ? 'primary' : 'default'}
                icon={<RobotOutlined />}
                onClick={() => setActiveTab('chat')}
                size="small"
              />
            </Tooltip>
            <Tooltip title="统计">
              <Button
                type={activeTab === 'stats' ? 'primary' : 'default'}
                icon={<DatabaseOutlined />}
                onClick={() => setActiveTab('stats')}
                size="small"
              />
            </Tooltip>
            <Tooltip title="历史">
              <Button
                type={activeTab === 'history' ? 'primary' : 'default'}
                icon={<HistoryOutlined />}
                onClick={() => setActiveTab('history')}
                size="small"
              />
            </Tooltip>
          </Space>
        }
      >
        {activeTab === 'chat' && (
          <>
            {/* Messages */}
            <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', paddingRight: 8 }}>
              {messages.length === 0 && (
                <div style={{ textAlign: 'center', padding: 40 }}>
                  <RobotOutlined style={{ fontSize: 56, color: '#d9d9d9', marginBottom: 20 }} />
                  <div style={{ color: '#666', fontSize: 15, marginBottom: 8 }}>
                    👋 Hi! 我是 Data-Agent
                  </div>
                  <div style={{ color: '#999', fontSize: 13, marginBottom: 24 }}>
                    问我任何关于缺陷数据的问题，我会自动生成 SQL、执行查询并给出业务洞察
                  </div>
                  <Space wrap>
                    {SUGGESTIONS.map((s) => (
                      <Button
                        key={s}
                        size="small"
                        ghost
                        type="primary"
                        onClick={() => sendMessage(s)}
                        style={{ marginBottom: 8 }}
                      >
                        {s}
                      </Button>
                    ))}
                  </Space>
                </div>
              )}

              {messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}

              {loading && (
                <div style={{ textAlign: 'center', padding: 16 }}>
                  <Spin size="small" />
                  <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                    Agent 正在思考...
                  </Text>
                </div>
              )}
            </div>

            {/* Input */}
            <div style={{ paddingTop: 12 }}>
              <Space.Compact style={{ width: '100%' }}>
                <TextArea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="输入问题，例如：IDCEVO 本月 Critical 缺陷有多少？"
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  onPressEnter={(e) => {
                    if (!e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  style={{ borderRadius: '8px 0 0 8px' }}
                  disabled={loading}
                />
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  onClick={() => sendMessage()}
                  loading={loading}
                  style={{ height: 'auto', borderRadius: '0 8px 8px 0' }}
                >
                  发送
                </Button>
              </Space.Compact>
            </div>
          </>
        )}

        {activeTab === 'stats' && <StatsPanel />}

        {activeTab === 'history' && <HistoryPanel />}
      </Card>
      </div>
    </div>
  );
};

// ============================================================================
// Message Bubble
// ============================================================================

const MessageBubble: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const isUser = message.role === 'user';
  const resp = message.response;

  return (
    <div style={{
      display: 'flex',
      flexDirection: isUser ? 'row-reverse' : 'row',
      gap: 8,
      marginBottom: 16,
    }}>
      <Avatar
        size="small"
        icon={isUser ? <UserOutlined /> : <RobotOutlined />}
        style={{ flexShrink: 0, marginTop: 2 }}
      />

      <div style={{ maxWidth: '80%' }}>
        {/* Content */}
        <div style={{
          background: isUser ? '#e6f4ff' : '#f5f5f5',
          padding: '8px 14px',
          borderRadius: 10,
          borderTopLeftRadius: isUser ? 10 : 2,
          borderTopRightRadius: isUser ? 2 : 10,
        }}>
          <Text style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>
            {message.content}
          </Text>
        </div>

        {/* Agent extras */}
        {resp && (
          <div style={{ marginTop: 4 }}>
            {/* Timing */}
            <Space size={8} style={{ fontSize: 11, color: '#999', marginBottom: 4 }}>
              <span>
                <ClockCircleOutlined /> {resp.total_time_ms.toFixed(0)}ms
              </span>
              {resp.tools_used.length > 0 && (
                <span>🔧 {resp.tools_used.join(', ')}</span>
              )}
            </Space>

            {/* Agent Steps */}
            {resp.steps.length > 0 && (
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12, color: '#1890ff' }}>
                  🧠 Agent 思考过程 ({resp.steps.length} 步)
                </summary>
                <div style={{ marginLeft: 8, marginTop: 4 }}>
                  <AgentStepDisplay steps={resp.steps} sqlExecuted={resp.sql_executed} />
                </div>
              </details>
            )}

            {/* Story */}
            {resp.story && <StoryCard story={resp.story} />}

            {/* Chart */}
            {resp.success && (
              <ChartRenderer data={{
                story_type: resp.story?.story_type,
                rows: extractRowsFromSteps(resp.steps),
                columns: extractColumnsFromSteps(resp.steps),
                answer: resp.answer,
                story: resp.story,
              }} />
            )}

            {/* Feedback */}
            {resp.memory_record_id && (
              <div style={{ marginTop: 4 }}>
                <FeedbackButtons memoryId={resp.memory_record_id} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// History Panel
// ============================================================================

const HistoryPanel: React.FC = () => {
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const loadHistory = async () => {
    setLoading(true);
    try {
      const data = await getHistory(30);
      setRecords(data.records);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  return (
    <div style={{ overflow: 'auto', height: '100%' }}>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between' }}>
        <Text strong>查询历史 ({records.length})</Text>
        <Button size="small" icon={<ReloadOutlined />} onClick={loadHistory} loading={loading}>
          刷新
        </Button>
      </div>

      {records.length === 0 && !loading && (
        <Empty description="暂无历史记录" />
      )}

      {records.map((r) => (
        <Card
          key={r.id}
          size="small"
          style={{ marginBottom: 8 }}
          hoverable
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <div style={{ flex: 1 }}>
              <Text strong style={{ fontSize: 13 }}>
                {r.feedback === 'up' ? '👍 ' : r.feedback === 'down' ? '👎 ' : ''}
                {r.question}
              </Text>
              <div style={{ marginTop: 4 }}>
                <Text code style={{ fontSize: 11 }}>
                  {r.sql.slice(0, 80)}{r.sql.length > 80 ? '...' : ''}
                </Text>
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: '#999' }}>
                {r.created_at.slice(0, 19).replace('T', ' ')} · 使用 {r.usage_count} 次 · 分 {r.score.toFixed(1)}
              </div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
};

export default AIChatPage;

// ============================================================================
// Helpers
// ============================================================================

function extractRowsFromSteps(steps: Array<{ type: string; tool_output?: unknown }>): Record<string, unknown>[] {
  for (const step of steps) {
    if (step.type === 'observation' && step.tool_output) {
      const output = step.tool_output as Record<string, unknown>;
      if (Array.isArray(output.rows)) return output.rows as Record<string, unknown>[];
      if (Array.isArray(output.data)) return output.data as Record<string, unknown>[];
    }
  }
  return [];
}

function extractColumnsFromSteps(steps: Array<{ type: string; tool_output?: unknown }>): string[] {
  const rows = extractRowsFromSteps(steps);
  if (rows.length > 0) return Object.keys(rows[0]);
  return [];
}
