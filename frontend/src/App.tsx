import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/auth';
import { api } from './services/api';
import LoginPage from './pages/LoginPage';
import ChatPage from './pages/ChatPage';
import ProfileSetupPage from './pages/ProfileSetupPage';
import SettingsPage from './pages/SettingsPage';
import AdminPage from './pages/AdminPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
    const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
    if (!isAuthenticated) return <Navigate to="/login" replace />;
    return <>{children}</>;
}

export default function App() {
    const [systemStatus, setSystemStatus] = useState<{ readOnly: boolean; maintenanceMode: boolean; allowed: boolean } | null>(null);
    const hydrateAuth = useAuthStore((s) => s.hydrate);

    useEffect(() => {
        void hydrateAuth();
    }, [hydrateAuth]);

    useEffect(() => {
        let active = true;
        const refresh = async () => {
            try {
                const status = await api.getSystemStatus();
                if (active) setSystemStatus(status);
            } catch {
                if (active) setSystemStatus({ readOnly: false, maintenanceMode: false, allowed: true });
            }
        };
        refresh();
        const interval = window.setInterval(refresh, 5000);
        return () => {
            active = false;
            window.clearInterval(interval);
        };
    }, []);

    if (!systemStatus) return <main className="system-status-loading" aria-label="Загрузка" />;
    if (systemStatus.maintenanceMode && !systemStatus.allowed) {
        return <main className="maintenance-page"><section><div className="maintenance-tool">🛠️</div><h1>Ремонтные работы!🛠️</h1><p>Скоро все уладим😊!</p></section></main>;
    }

    return (
        <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
                path="/profile-setup"
                element={
                    <ProtectedRoute>
                        <ProfileSetupPage />
                    </ProtectedRoute>
                }
            />
            <Route
                path="/chat/:chatId?"
                element={
                    <ProtectedRoute>
                        <ChatPage />
                    </ProtectedRoute>
                }
            />
            <Route
                path="/settings/:section?"
                element={
                    <ProtectedRoute>
                        <SettingsPage />
                    </ProtectedRoute>
                }
            />
            <Route
                path="/admin"
                element={
                    <ProtectedRoute>
                        <AdminPage />
                    </ProtectedRoute>
                }
            />
            <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
    );
}
