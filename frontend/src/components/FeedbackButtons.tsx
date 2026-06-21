/** FeedbackButtons — 👍/👎 反馈 */

import React, { useState } from 'react';
import { Button, Tooltip, Input, Modal, Space } from 'antd';
import { LikeOutlined, DislikeOutlined, LikeFilled, DislikeFilled } from '@ant-design/icons';
import { sendFeedback } from '../api/client';

interface Props {
  memoryId: string | null;
  onFeedback?: (feedback: 'up' | 'down') => void;
}

const FeedbackButtons: React.FC<Props> = ({ memoryId, onFeedback }) => {
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);

  const handleFeedback = (type: 'up' | 'down') => {
    if (!memoryId) return;
    setFeedback(type);

    if (type === 'down') {
      setModalOpen(true);
    } else {
      submitFeedback(type, '');
    }
  };

  const submitFeedback = async (type: 'up' | 'down', userNote: string) => {
    if (!memoryId) return;
    setLoading(true);
    try {
      await sendFeedback(memoryId, type, userNote);
      onFeedback?.(type);
    } catch (err) {
      console.error('Feedback failed:', err);
    } finally {
      setLoading(false);
      setModalOpen(false);
    }
  };

  if (!memoryId) return null;

  return (
    <>
      <Space size={4}>
        <Tooltip title="回答准确">
          <Button
            type="text"
            size="small"
            icon={feedback === 'up' ? <LikeFilled style={{ color: '#52c41a' }} /> : <LikeOutlined />}
            onClick={() => handleFeedback('up')}
            disabled={!!feedback}
          />
        </Tooltip>
        <Tooltip title="回答有误">
          <Button
            type="text"
            size="small"
            icon={feedback === 'down' ? <DislikeFilled style={{ color: '#ff4d4f' }} /> : <DislikeOutlined />}
            onClick={() => handleFeedback('down')}
            disabled={!!feedback}
          />
        </Tooltip>
        {feedback && (
          <span style={{ fontSize: 11, color: '#999' }}>
            {feedback === 'up' ? '已点赞' : '已反馈'}
          </span>
        )}
      </Space>

      <Modal
        title="反馈详情"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => submitFeedback('down', note)}
        okText="提交"
        cancelText="取消"
        confirmLoading={loading}
      >
        <Input.TextArea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="请描述问题或正确的答案应该是什么..."
          rows={3}
        />
      </Modal>
    </>
  );
};

export default FeedbackButtons;
