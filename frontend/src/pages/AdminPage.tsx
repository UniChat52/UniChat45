import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../store/auth';
import VerifiedBadge from '../components/VerifiedBadge';

type AdminStats = { totalUsers: number; totalChats: number; totalMessages: number; activeReports: number };
type AdminUser = { id: string; phone: string; username: string | null; displayName: string | null; isAdmin: boolean; isBlocked: boolean; isVerified: boolean; createdAt: string; _count: { messages: number } };
type AdminChannel = { id: string; name: string | null; isBlocked: boolean; isVerified: boolean; createdAt: string; _count: { members: number; messages: number } };

export default function AdminPage() {
    const navigate = useNavigate();
    const setUser = useAuthStore((state) => state.setUser);
    const currentUserId = useAuthStore((state) => state.user?.id);
    const [stats, setStats] = useState<AdminStats | null>(null);
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [channels, setChannels] = useState<AdminChannel[]>([]);
    const [systemSettings, setSystemSettings] = useState({ readOnly: false, readOnlyUserIds: [] as string[], maintenanceMode: false, maintenanceUserIds: [] as string[] });
    const [workingId, setWorkingId] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        let active = true;
        const load = async () => {
            try {
                const currentUser = await api.getMe();
                if (!currentUser.isAdmin) {
                    navigate('/settings/profile', { replace: true });
                    return;
                }
                setUser(currentUser);
                const [result, channelList, currentSettings] = await Promise.all([
                    api.getAdminStats(),
                    api.getAdminChannels(),
                    api.getAdminSystemSettings(),
                ]);
                let page = 1;
                let total = Number.POSITIVE_INFINITY;
                const allUsers: AdminUser[] = [];
                while (allUsers.length < total) {
                    const batch = await api.getAdminUsers(page, 100);
                    allUsers.push(...batch.users);
                    total = batch.total;
                    page++;
                }
                if (active) {
                    setStats(result);
                    setChannels(channelList);
                    setUsers(allUsers);
                    setSystemSettings(currentSettings);
                }
            } catch (cause) {
                if (active) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить панель');
            }
        };
        load();
        return () => { active = false; };
    }, []);

    const updateSystemSettings = async (change: Partial<typeof systemSettings>) => {
        setWorkingId('system-settings');
        setError('');
        try {
            const updated = await api.updateAdminSystemSettings({ ...systemSettings, ...change });
            setSystemSettings(updated);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Не удалось изменить режим системы');
        } finally {
            setWorkingId('');
        }
    };

    const toggleUserBlock = async (user: AdminUser) => {
        setWorkingId(user.id);
        setError('');
        try {
            const result = await api.setAdminUserBlocked(user.id, !user.isBlocked);
            setUsers((current) => current.map((item) => item.id === user.id ? { ...item, isBlocked: result.isBlocked } : item));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Не удалось изменить статус аккаунта');
        } finally {
            setWorkingId('');
        }
    };

    const toggleUserVerified = async (account: AdminUser) => {
        setWorkingId(account.id);
        setError('');
        try {
            const result = await api.setAdminUserVerified(account.id, !account.isVerified);
            setUsers((current) => current.map((item) => item.id === account.id ? { ...item, isVerified: result.isVerified } : item));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Не удалось изменить верификацию аккаунта');
        } finally {
            setWorkingId('');
        }
    };

    const deleteUser = async (user: AdminUser) => {
        if (!window.confirm(`Удалить аккаунт ${user.displayName || user.username || user.phone}? Это действие нельзя отменить.`)) return;
        setWorkingId(user.id);
        setError('');
        try {
            await api.deleteAdminUser(user.id);
            setUsers((current) => current.filter((item) => item.id !== user.id));
            setStats((current) => current ? { ...current, totalUsers: current.totalUsers - 1 } : current);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Не удалось удалить аккаунт');
        } finally {
            setWorkingId('');
        }
    };

    const toggleChannelBlock = async (channel: AdminChannel) => {
        setWorkingId(channel.id);
        setError('');
        try {
            const result = await api.setAdminChannelBlocked(channel.id, !channel.isBlocked);
            setChannels((current) => current.map((item) => item.id === channel.id ? { ...item, isBlocked: result.isBlocked } : item));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Не удалось изменить статус канала');
        } finally {
            setWorkingId('');
        }
    };

    const toggleChannelVerified = async (channel: AdminChannel) => {
        setWorkingId(channel.id);
        setError('');
        try {
            const result = await api.setAdminChannelVerified(channel.id, !channel.isVerified);
            setChannels((current) => current.map((item) => item.id === channel.id ? { ...item, isVerified: result.isVerified } : item));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Не удалось изменить верификацию канала');
        } finally {
            setWorkingId('');
        }
    };

    const deleteChannel = async (channel: AdminChannel) => {
        if (!window.confirm(`Удалить канал «${channel.name || 'Без названия'}» и все его сообщения? Это действие нельзя отменить.`)) return;
        setWorkingId(channel.id);
        setError('');
        try {
            await api.deleteAdminChannel(channel.id);
            setChannels((current) => current.filter((item) => item.id !== channel.id));
            setStats((current) => current ? { ...current, totalChats: current.totalChats - 1, totalMessages: current.totalMessages - channel._count.messages } : current);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Не удалось удалить канал');
        } finally {
            setWorkingId('');
        }
    };

    return (
        <main className="settings-page admin-page">
            <section className="settings-content">
                <header className="settings-topbar admin-topbar">
                    <button className="btn-icon" onClick={() => navigate('/settings/profile')} title="Назад в настройки">←</button>
                    <strong>🛡️ Админ-панель</strong>
                </header>
                <div className="settings-body">
                    {error && <p className="settings-error" role="alert">{error}</p>}
                    {!stats && !error && <p className="settings-empty">Загрузка...</p>}
                    {stats && <div className="admin-dashboard">
                        <div className="admin-stats-grid">
                            <div><span>Пользователи</span><strong>{stats.totalUsers}</strong></div>
                            <div><span>Чаты</span><strong>{stats.totalChats}</strong></div>
                            <div><span>Сообщения</span><strong>{stats.totalMessages}</strong></div>
                            <div><span>Жалобы без ответа</span><strong>{stats.activeReports}</strong></div>
                        </div>

                        <section className="admin-section admin-system-settings">
                            <h2>Режимы работы</h2>
                            <label className="admin-system-toggle">
                                <span><strong>Режим чтения</strong><small>Запретить отправку, изменение и удаление сообщений и чатов</small></span>
                                <input type="checkbox" checked={systemSettings.readOnly} disabled={workingId === 'system-settings'} onChange={(event) => updateSystemSettings({ readOnly: event.target.checked })} />
                            </label>
                            {systemSettings.readOnly && <div className="admin-maintenance-users">
                                <strong>Кому разрешено писать в режиме чтения</strong>
                                <p>@vaksik14 всегда может писать</p>
                                {users.filter((account) => account.username !== 'vaksik14' && !account.isBlocked).map((account) => (
                                    <label className="admin-maintenance-user" key={account.id}>
                                        <span>{account.displayName || account.username || account.phone}{account.username ? ` · @${account.username}` : ''}</span>
                                        <input type="checkbox" checked={systemSettings.readOnlyUserIds.includes(account.id)} disabled={workingId === 'system-settings'} onChange={(event) => {
                                            const readOnlyUserIds = event.target.checked
                                                ? [...systemSettings.readOnlyUserIds, account.id]
                                                : systemSettings.readOnlyUserIds.filter((id) => id !== account.id);
                                            updateSystemSettings({ readOnlyUserIds });
                                        }} />
                                    </label>
                                ))}
                            </div>}
                            <label className="admin-system-toggle">
                                <span><strong>Ремонтные работы</strong><small>Доступ останется у @vaksik14 и отмеченных аккаунтов</small></span>
                                <input type="checkbox" checked={systemSettings.maintenanceMode} disabled={workingId === 'system-settings'} onChange={(event) => {
                                    if (event.target.checked && !window.confirm('Остальные пользователи потеряют доступ к мессенджеру. Включить ремонтные работы?')) return;
                                    updateSystemSettings({ maintenanceMode: event.target.checked });
                                }} />
                            </label>
                            {systemSettings.maintenanceMode && <div className="admin-maintenance-users">
                                <strong>Кому разрешить доступ во время ремонта</strong>
                                <p>@vaksik14 всегда сохраняет доступ</p>
                                {users.filter((account) => account.username !== 'vaksik14' && !account.isBlocked).map((account) => (
                                    <label className="admin-maintenance-user" key={account.id}>
                                        <span>{account.displayName || account.username || account.phone}{account.username ? ` · @${account.username}` : ''}</span>
                                        <input type="checkbox" checked={systemSettings.maintenanceUserIds.includes(account.id)} disabled={workingId === 'system-settings'} onChange={(event) => {
                                            const maintenanceUserIds = event.target.checked
                                                ? [...systemSettings.maintenanceUserIds, account.id]
                                                : systemSettings.maintenanceUserIds.filter((id) => id !== account.id);
                                            updateSystemSettings({ maintenanceUserIds });
                                        }} />
                                    </label>
                                ))}
                            </div>}
                        </section>

                        <section className="admin-section">
                            <h2>Аккаунты <span>{users.length}</span></h2>
                            {!users.length && <p className="settings-empty">Аккаунтов нет</p>}
                            {users.map((account) => <div className="admin-row" key={account.id}>
                                <div className="admin-row-info">
                                    <strong>{account.displayName || account.username || 'Без имени'} {account.isAdmin && <small>Администратор</small>} {account.isVerified && <VerifiedBadge />}</strong>
                                    <span>{account.username ? `@${account.username} · ` : ''}{account.phone}</span>
                                    <span>{account.isBlocked ? 'Заблокирован' : 'Активен'} · сообщений: {account._count.messages}</span>
                                </div>
                                <div className="admin-row-actions">
                                    <button className="btn btn-secondary" disabled={workingId === account.id} onClick={() => toggleUserVerified(account)}>
                                        {account.isVerified ? 'Снять верификацию' : 'Верифицировать'}
                                    </button>
                                    <button className="btn btn-secondary" disabled={workingId === account.id || account.id === currentUserId} onClick={() => toggleUserBlock(account)}>
                                        {account.isBlocked ? 'Разблокировать' : 'Заблокировать'}
                                    </button>
                                    <button className="btn btn-danger" disabled={workingId === account.id || account.id === currentUserId} onClick={() => deleteUser(account)}>Удалить</button>
                                </div>
                            </div>)}
                        </section>

                        <section className="admin-section">
                            <h2>Каналы <span>{channels.length}</span></h2>
                            {!channels.length && <p className="settings-empty">Каналов пока нет</p>}
                            {channels.map((channel) => <div className="admin-row" key={channel.id}>
                                <div className="admin-row-info">
                                    <strong>{channel.name || 'Без названия'} {channel.isVerified && <VerifiedBadge label="Верифицированный канал" />}</strong>
                                    <span>{channel.isBlocked ? 'Заблокирован' : 'Активен'} · участников: {channel._count.members} · сообщений: {channel._count.messages}</span>
                                </div>
                                <div className="admin-row-actions">
                                    <button className="btn btn-secondary" disabled={workingId === channel.id} onClick={() => toggleChannelVerified(channel)}>
                                        {channel.isVerified ? 'Снять верификацию' : 'Верифицировать'}
                                    </button>
                                    <button className="btn btn-secondary" disabled={workingId === channel.id} onClick={() => toggleChannelBlock(channel)}>
                                        {channel.isBlocked ? 'Разблокировать' : 'Заблокировать'}
                                    </button>
                                    <button className="btn btn-danger" disabled={workingId === channel.id} onClick={() => deleteChannel(channel)}>Удалить</button>
                                </div>
                            </div>)}
                        </section>
                    </div>}
                </div>
            </section>
        </main>
    );
}