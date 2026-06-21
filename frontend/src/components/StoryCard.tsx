/** StoryCard — 数据故事展示 */

import React from 'react';
import { Card, Typography, List, Tag, Alert, Empty } from 'antd';
import { BulbOutlined, FireOutlined, RiseOutlined, FallOutlined } from '@ant-design/icons';
import type { DataStory } from '../types';

const { Title, Paragraph } = Typography;

interface Props {
  story: DataStory | null;
}

const StoryCard: React.FC<Props> = ({ story }) => {
  if (!story) return null;

  const typeColors: Record<string, string> = {
    count: 'blue',
    trend: 'orange',
    distribution: 'purple',
    ranking: 'gold',
    summary: 'green',
    comparison: 'cyan',
  };

  const color = typeColors[story.story_type] || 'default';

  return (
    <Card
      size="small"
      style={{
        marginTop: 12,
        background: 'linear-gradient(135deg, #f6f9ff 0%, #fff 100%)',
        border: '1px solid #e8ecf0',
        borderRadius: 8,
      }}
    >
      {/* Headline */}
      <div style={{ marginBottom: 8 }}>
        <Tag color={color} style={{ marginBottom: 4 }}>
          📊 {story.story_type.toUpperCase()}
        </Tag>
        <Title level={5} style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
          {story.headline}
        </Title>
      </div>

      {/* Body */}
      {story.body && (
        <Paragraph type="secondary" style={{ fontSize: 12, whiteSpace: 'pre-wrap', marginBottom: 8 }}>
          {story.body}
        </Paragraph>
      )}

      {/* Insights */}
      {story.insights.length > 0 && (
        <List
          size="small"
          split={false}
          dataSource={story.insights}
          renderItem={(item) => (
            <List.Item style={{ padding: '2px 0', border: 'none' }}>
              <Text style={{ fontSize: 12 }}>
                • {item}
              </Text>
            </List.Item>
          )}
        />
      )}

      {/* Recommendation */}
      {story.recommendation && (
        <Alert
          type="info"
          showIcon
          icon={<BulbOutlined />}
          message={story.recommendation}
          style={{
            marginTop: 8,
            fontSize: 12,
            padding: '6px 12px',
            borderRadius: 6,
          }}
        />
      )}
    </Card>
  );
};

const Text = Typography.Text;

export default StoryCard;
