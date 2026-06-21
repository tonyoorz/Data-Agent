/**
 * ChartRenderer — 根据查询结果数据自动选择并渲染 ECharts 图表
 *
 * 选型规则:
 * - count (单数值) → Statistic 数字卡片
 * - trend (时间序列) → Line 折线图
 * - distribution (分类+数值) → Pie 饼图 / Bar 柱状图
 * - ranking (排序数据) → Bar 横向柱状图
 * - summary (多维统计) → Radar 雷达图 / 多 Statistic
 */

import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { Card, Empty, Statistic, Row, Col, Table, Typography, Tag } from 'antd';
import type { DataStory } from '../types';

const { Text } = Typography;

export interface ChartData {
  story_type?: string;
  rows?: Record<string, unknown>[];
  columns?: string[];
  answer?: string;
  story?: DataStory | null;
}

const COLORS = [
  '#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de',
  '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc', '#5ab1ef',
];

const ChartRenderer: React.FC<{ data: ChartData }> = ({ data }) => {
  const chart = useMemo(() => selectChart(data), [data]);
  return chart;
};

// ============================================================================
// Chart Selection Logic
// ============================================================================

function selectChart(data: ChartData): React.ReactElement {
  const { story_type, rows, answer, story } = data;

  // No data
  if (!rows || rows.length === 0) {
    if (story_type === 'count' || (answer && extractNumber(answer) !== null)) {
      const num = extractNumber(answer || '') ?? 0;
      return <CountChart value={num} story={story} />;
    }
    return <Empty description="无可视化数据" />;
  }

  // Count: single number
  if (story_type === 'count') {
    const num = extractNumber(answer || '') ?? (rows[0]?.count as number) ?? 0;
    return <CountChart value={num} story={story} />;
  }

  // Detect columns
  const columns = data.columns || Object.keys(rows[0]);
  const hasLabel = columns.some(c => ['label', 'name', 'project', 'severity', 'ecu', 'status', 'team', 'module'].includes(c.toLowerCase()));
  const hasValue = columns.some(c => ['count', 'total', 'value', 'num', 'amount'].includes(c.toLowerCase()));
  const hasTime = columns.some(c => ['period', 'date', 'time', 'month', 'week', 'day'].includes(c.toLowerCase()));

  // Trend: time series → Line chart
  if (story_type === 'trend' || hasTime) {
    return <LineChart rows={rows} columns={columns} story={story} />;
  }

  // Ranking: sorted data → Horizontal Bar
  if (story_type === 'ranking') {
    return <BarChart rows={rows} columns={columns} horizontal story={story} />;
  }

  // Distribution: category + value → Pie or Bar
  if (story_type === 'distribution' || (hasLabel && hasValue)) {
    if (rows.length <= 6) {
      return <PieChart rows={rows} columns={columns} story={story} />;
    }
    return <BarChart rows={rows} columns={columns} story={story} />;
  }

  // Summary: multi-stat → Statistic cards
  if (story_type === 'summary') {
    return <SummaryChart rows={rows[0]} story={story} />;
  }

  // Fallback: Table
  return <DataTable rows={rows} columns={columns} />;
}

// ============================================================================
// Individual Chart Components
// ============================================================================

const CountChart: React.FC<{ value: number; story?: DataStory | null }> = ({ value, story }) => (
  <Card size="small" style={{ marginTop: 12, textAlign: 'center', background: 'linear-gradient(135deg, #e6f4ff 0%, #f6f9ff 100%)' }}>
    <Statistic
      value={value}
      prefix={value > 50 ? '🔴' : value > 20 ? '🟡' : value > 0 ? '🟢' : '✅'}
      suffix="个"
      valueStyle={{
        fontSize: 36,
        fontWeight: 700,
        color: value > 50 ? '#ff4d4f' : value > 20 ? '#faad14' : '#52c41a',
      }}
    />
    {story?.headline && (
      <Text type="secondary" style={{ fontSize: 12 }}>
        {story.headline}
      </Text>
    )}
  </Card>
);

const LineChart: React.FC<{ rows: Record<string, unknown>[]; columns: string[]; story?: DataStory | null }> = ({ rows, columns, story }) => {
  const timeKey = columns.find(c => ['period', 'date', 'time', 'month', 'week', 'day'].includes(c.toLowerCase())) || columns[0];
  const valueKey = columns.find(c => ['count', 'total', 'value', 'num'].includes(c.toLowerCase())) || columns[1];

  const option = {
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 20, top: 20, bottom: 30 },
    xAxis: {
      type: 'category',
      data: rows.map(r => String(r[timeKey] || '')),
      axisLabel: { fontSize: 11 },
    },
    yAxis: { type: 'value', axisLabel: { fontSize: 11 } },
    series: [{
      type: 'line',
      data: rows.map(r => Number(r[valueKey] || 0)),
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { width: 2, color: '#5470c6' },
      itemStyle: { color: '#5470c6' },
      areaStyle: {
        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [
          { offset: 0, color: 'rgba(84,112,198,0.3)' },
          { offset: 1, color: 'rgba(84,112,198,0.02)' },
        ]},
      },
      markPoint: {
        data: [
          { type: 'max', name: '峰值' },
          { type: 'min', name: '低谷' },
        ],
      },
    }],
  };

  return (
    <Card size="small" style={{ marginTop: 12 }}>
      {story?.headline && <Text strong style={{ fontSize: 13 }}>{story.headline}</Text>}
      <ReactECharts option={option} style={{ height: 260 }} />
    </Card>
  );
};

const BarChart: React.FC<{ rows: Record<string, unknown>[]; columns: string[]; horizontal?: boolean; story?: DataStory | null }> = ({ rows, columns, horizontal, story }) => {
  const labelKey = columns.find(c => ['label', 'name', 'project', 'severity', 'ecu', 'status'].includes(c.toLowerCase())) || columns[0];
  const valueKey = columns.find(c => ['count', 'total', 'value', 'num'].includes(c.toLowerCase())) || columns[1];

  const labels = rows.map(r => String(r[labelKey] || ''));
  const values = rows.map(r => Number(r[valueKey] || 0));

  const option = horizontal ? {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 80, right: 30, top: 20, bottom: 20 },
    xAxis: { type: 'value', axisLabel: { fontSize: 11 } },
    yAxis: { type: 'category', data: labels.reverse(), axisLabel: { fontSize: 11 } },
    series: [{
      type: 'bar',
      data: values.reverse(),
      itemStyle: { color: COLORS[0], borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', fontSize: 11 },
    }],
  } : {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 40, right: 20, top: 20, bottom: 40 },
    xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 11, rotate: labels.length > 5 ? 30 : 0 } },
    yAxis: { type: 'value', axisLabel: { fontSize: 11 } },
    series: [{
      type: 'bar',
      data: values.map((v, i) => ({ value: v, itemStyle: { color: COLORS[i % COLORS.length] } })),
      label: { show: true, position: 'top', fontSize: 11 },
      barMaxWidth: 40,
    }],
  };

  return (
    <Card size="small" style={{ marginTop: 12 }}>
      {story?.headline && <Text strong style={{ fontSize: 13 }}>{story.headline}</Text>}
      <ReactECharts option={option} style={{ height: 260 }} />
    </Card>
  );
};

const PieChart: React.FC<{ rows: Record<string, unknown>[]; columns: string[]; story?: DataStory | null }> = ({ rows, columns, story }) => {
  const labelKey = columns.find(c => ['label', 'name', 'project', 'severity', 'ecu', 'status'].includes(c.toLowerCase())) || columns[0];
  const valueKey = columns.find(c => ['count', 'total', 'value', 'num'].includes(c.toLowerCase())) || columns[1];

  const pieData = rows.map(r => ({ name: String(r[labelKey] || ''), value: Number(r[valueKey] || 0) }));

  const option = {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0, fontSize: 11 },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      center: ['50%', '45%'],
      data: pieData,
      label: { fontSize: 11, formatter: '{b}\n{d}%' },
      itemStyle: { borderColor: '#fff', borderWidth: 2 },
      color: COLORS,
    }],
  };

  return (
    <Card size="small" style={{ marginTop: 12 }}>
      {story?.headline && <Text strong style={{ fontSize: 13 }}>{story.headline}</Text>}
      <ReactECharts option={option} style={{ height: 260 }} />
    </Card>
  );
};

const SummaryChart: React.FC<{ rows: Record<string, unknown>; story?: DataStory | null }> = ({ rows, story }) => {
  const entries = Object.entries(rows).filter(([, v]) => typeof v === 'number' || !isNaN(Number(v)));

  return (
    <Card size="small" style={{ marginTop: 12 }}>
      {story?.headline && <Text strong style={{ fontSize: 13 }}>{story.headline}</Text>}
      <Row gutter={[12, 12]} style={{ marginTop: 8 }}>
        {entries.map(([key, value], i) => (
          <Col span={6} key={key}>
            <Statistic
              title={key}
              value={Number(value)}
              valueStyle={{ fontSize: 20, fontWeight: 600, color: COLORS[i % COLORS.length] }}
            />
          </Col>
        ))}
      </Row>
    </Card>
  );
};

const DataTable: React.FC<{ rows: Record<string, unknown>[]; columns: string[] }> = ({ rows, columns }) => {
  const tableColumns = columns.map(c => ({
    title: c,
    dataIndex: c,
    key: c,
    sorter: (a: Record<string, unknown>, b: Record<string, unknown>) => {
      const av = a[c]; const bv = b[c];
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv));
    },
  }));

  return (
    <Card size="small" style={{ marginTop: 12 }}>
      <Table
        dataSource={rows.map((r, i) => ({ ...r, key: i }))}
        columns={tableColumns}
        size="small"
        pagination={{ pageSize: 5, size: 'small' }}
        scroll={{ x: 'max-content' }}
      />
    </Card>
  );
};

// ============================================================================
// Helpers
// ============================================================================

function extractNumber(text: string): number | null {
  const patterns = [/(\d+)\s*个/, /共\s*(\d+)/, /总计\s*(\d+)/, /[:：]\s*(\d+)/, /=\s*(\d+)/];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return parseInt(m[1], 10);
  }
  const fallback = text.match(/\b(\d+)\b/);
  return fallback ? parseInt(fallback[1], 10) : null;
}

export default ChartRenderer;
