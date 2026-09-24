import React from 'react';
import ReactDOM from 'react-dom/client';
import { TooltipProvider } from '@cloudflare/kumo';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </React.StrictMode>
);
