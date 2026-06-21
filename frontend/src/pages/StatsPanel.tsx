/** StatsPanel — 记忆与反馈统计 */

import React, { useEffect, useState } from 'react';
import { Spin, Empty, Row, Col, Statistic, Card, Typography, Tag, List } from 'antd';
import {
  DatabaseOutlined, CheckCircleOutlined, LikeOutlined, DislikeOutlined,
} from '@ant-design/icons';
import { getStats } from '../api/client';
import type { MemoryStats } from '../types';

const { Text } = Typography;

const StatsPanel: React.FC = () => {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getStats().then(setStats).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>;
  if (!stats) return <Empty description="暂无数据" />;

  const mem = stats.memory;
  const fb = stats.feedback;

  return (
    <div style={{ overflow: 'auto', height: '100%', padding: 8 }}>
      <Text strong style={{ fontSize: 16 }}>📊 Agent 记忆统计</Text>

      <Row gutter={[12, 12]} style={{ marginTop: 16 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="总查询"
              value={mem.total_records}
              prefix={<DatabaseOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="成功率"
              value={(mem.success_rate * 100).toFixed(1)}
              suffix="%"
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: mem.success_rate > 0.8 ? '#3f8600' : '#cf1322' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="👍 点赞"
              value={mem.thumbs_up}
              prefix={<LikeOutlined />}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="👎 踩"
              value={mem.thumbs_down}
              prefix={<DislikeOutlined />}
              valueStyle={{ color: '#ff4d4f' }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="平均评分" value={mem.avg_score.toFixed(2)} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="满意度"
              value={(fb.satisfaction_rate * 100).toFixed(1)}
              suffix="%"
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="反馈总数" value={fb.total} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <div style={{ marginBottom: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>权重调整</Text>
            </div>
            {Object.entries(stats.weight_adjustments).length === 0 ? (
              <Text type="secondary" style={{ fontSize: 12 }}>无</Text>
            ) : (
              Object.entries(stats.weight_adjustments).map(([k, v]) => (
                <Tag key={k} color={v > 0 ? 'green' : 'red'} style={{ fontSize: 11 }}>
                  {k}: {v > 0 ? '+' : ''}{v}
                </Tag>
              ))
            )}
          </Card>
        </Col>
      </Row>

      {/* Negative notes */}
      {fb.negative_notes.length > 0 && (
        <Card size="small" title="⚠️ 负面反馈 (待改进)" style={{ marginTop: 16 }}>
          <List
            size="small"
            dataSource={fb.negative_notes}
            renderItem={(item) => (
              <List.Item>
                <div>
                  <Text strong style={{ fontSize: 13 }}>{item.question}</Text>
                  {item.note && (
                    <div style={{ fontSize: 12, color: '#666' }}>
                      💬 {item.note}
                    </div>
                  )}
                  {item.correction && (
                    <div style={{ fontSize: 12, color: '#999' }}>
                      ✏️ {item.correction}
                    </div>
                  )}
                </div>
              </List.Item>
            )}
          />
        </Card>
      )}
    </div>
  );
};

export default StatsPanel;
