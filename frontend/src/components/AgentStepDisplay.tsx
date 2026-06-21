/** AgentStepDisplay — 展示 ReAct 思考过程 */

import React from 'react';
import { Timeline, Typography, Tag, Collapse, Empty } from 'antd';
import {
  BulbOutlined,
  ToolOutlined,
  EyeOutlined,
  CheckCircleOutlined,
  CodeOutlined,
} from '@ant-design/icons';
import type { AgentStep } from '../types';

const { Text, Paragraph } = Typography;

interface Props {
  steps: AgentStep[];
  sqlExecuted: string[];
}

const stepConfig: Record<string, any> = {
  thought: { color: 'blue', icon: <BulbOutlined />, label: '思考' },
  action: { color: 'processing', icon: <ToolOutlined />, label: '行动' },
  observation: { color: 'gold', icon: <EyeOutlined />, label: '观察' },
  final: { color: 'green', icon: <CheckCircleOutlined />, label: '结论' },
  error: { color: 'red', icon: <CheckCircleOutlined />, label: '错误' },
};

const AgentStepDisplay: React.FC<Props> = ({ steps, sqlExecuted }) => {
  if (!steps.length && !sqlExecuted.length) return <Empty description="无执行步骤" />;

  const items: any[] = steps.map((step: any, i: number) => {
    const cfg = stepConfig[step.type] || stepConfig.thought;
    return {
      key: i,
      color: cfg.color as any,
      dot: cfg.icon as any,
      children: (
        <div style={{ paddingBottom: 4 }}>
          <div style={{ marginBottom: 2 }}>
            <Tag color={cfg.color} style={{ fontSize: 11 }}>
              {cfg.label}
            </Tag>
            {step.tool && (
              <Tag color="geekblue" style={{ fontSize: 11 }}>
                🔧 {step.tool}
              </Tag>
            )}
          </div>
          <Text style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>
            {String(step.content)}
          </Text>

          {/* Show tool output preview for observations */}
          {step.type === 'observation' && step.tool_output && Array.isArray(step.tool_output) && (
            <div style={{ marginTop: 4, fontSize: 12, color: '#888' }}>
              返回 {(step.tool_output as unknown[]).length} 行数据
            </div>
          )}
        </div>
      ),
    };
  });

  // Add SQL section
  if (sqlExecuted.length) {
    items.push({
      key: 'sql',
      color: 'gray' as any,
      dot: <CodeOutlined /> as any,
      children: (
        <Collapse
          ghost
          size="small"
          items={[{
            key: 'sql',
            label: <Text code style={{ fontSize: 11 }}>SQL ({sqlExecuted.length})</Text>,
            children: sqlExecuted.map((sql, i) => (
              <Paragraph key={i} code copyable style={{ fontSize: 12, marginBottom: 4 }}>
                {sql}
              </Paragraph>
            )),
          }]}
        />
      ),
    });
  }

  return <Timeline items={items} />;
};

export default AgentStepDisplay;
