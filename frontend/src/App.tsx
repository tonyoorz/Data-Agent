import React from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AIChatPage from './pages/AIChatPage';

const App: React.FC = () => {
  return (
    <ConfigProvider locale={zhCN}>
      <div style={{ padding: 16, height: '100vh', background: '#f0f2f5' }}>
        <AIChatPage />
      </div>
    </ConfigProvider>
  );
};

export default App;
