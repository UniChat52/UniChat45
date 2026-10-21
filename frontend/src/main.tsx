import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './i18n';
import './styles/index.css';

const systemTheme = window.matchMedia('(prefers-color-scheme: light)');
const applyTheme = () => {
    const theme = localStorage.getItem('unichat-theme') || 'system';
    document.documentElement.dataset.theme = theme === 'system'
        ? (systemTheme.matches ? 'light' : 'dark')
        : theme;
};
applyTheme();
systemTheme.addEventListener('change', () => {
    if ((localStorage.getItem('unichat-theme') || 'system') === 'system') applyTheme();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <BrowserRouter>
            <App />
        </BrowserRouter>
    </React.StrictMode>
);
