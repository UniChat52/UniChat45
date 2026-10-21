import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { useAuthStore } from '../store/auth';
import VerifiedBadge from '../components/VerifiedBadge';

const sections = [
    { id: 'profile', title: 'Профиль', icon: '👤' },
    { id: 'folders', title: 'Папки', icon: '📂' },
    { id: 'security', title: 'Безопасность', icon: '🔒' },
    { id: 'devices', title: 'Устройства', icon: '💻' },
    { id: 'notifications', title: 'Уведомления', icon: '🔔' },
    { id: 'appearance', title: 'Оформление', icon: '🪄' },
    { id: 'language', title: 'Язык приложения', icon: '🌐' },
    { id: 'premium', title: 'UniChat Premium', icon: '⭐' },
    { id: 'invite', title: 'Пригласить друзей', icon: '🔗' },
    { id: 'about', title: 'О приложении', icon: 'ⓘ' },
    { id: 'admin', title: 'Админ-панель', icon: '🛡️' },
] as const;

type SectionId = typeof sections[number]['id'];
type DeviceSession = { id: string; userAgent: string | null; ipAddress: string | null; createdAt: string; expiresAt: string };
type FolderDefinition = { id: string; label: string; icon: string; filters?: { categories: string[]; soundOnly: boolean; unreadOnly: boolean } };

const folderCategories = [
    { id: 'contacts', label: 'Контакты', icon: '♙', group: 'ТИПЫ ЧАТОВ' },
    { id: 'nonContacts', label: 'Не контакты', icon: '♙', group: 'ТИПЫ ЧАТОВ' },
    { id: 'groups', label: 'Группы', icon: '♧', group: 'ТИПЫ ЧАТОВ' },
    { id: 'channels', label: 'Каналы', icon: '⚑', group: 'ТИПЫ ЧАТОВ' },
    { id: 'bots', label: 'Боты', icon: '▣', group: 'ТИПЫ ЧАТОВ' },
    { id: 'saved', label: 'Избранное', icon: '▮', group: 'ЧАТЫ И КАНАЛЫ', description: 'Сообщения для себя' },
];

const FOLDER_STORAGE_KEY = 'unichat-folder-order';
const DEFAULT_FOLDERS: FolderDefinition[] = [
    { id: 'all', label: 'Все', icon: '☷', filters: { categories: [], soundOnly: false, unreadOnly: false } },
    { id: 'new', label: 'Новые', icon: '📁', filters: { categories: [], soundOnly: false, unreadOnly: true } },
    { id: 'channels', label: 'Каналы', icon: '📁', filters: { categories: ['channels'], soundOnly: false, unreadOnly: false } },
];
const DEFAULT_FOLDER_IDS = new Set(DEFAULT_FOLDERS.map((folder) => folder.id));
const CHAT_THEMES = [
    { id: 'cosmos', label: 'Космос' },
    { id: 'decisive', label: 'Решительная' },
    { id: 'elegant', label: 'Изящная' },
    { id: 'summer-forest', label: 'Летний лес' },
    { id: 'neon', label: 'Неон' },
] as const;

function readPreference(key: string, fallback: boolean) {
    return localStorage.getItem(key) === null ? fallback : localStorage.getItem(key) === 'true';
}

function getFolderConfig(): FolderDefinition[] {
    try {
        const raw = JSON.parse(localStorage.getItem(FOLDER_STORAGE_KEY) || 'null');
        if (!Array.isArray(raw) || !raw.length) return DEFAULT_FOLDERS;
        const normalized = raw
            .map((item) => {
                if (!item || typeof item !== 'object') return null;
                const id = String(item.id || '').trim();
                const label = String(item.label || '').trim();
                if (!id || !label) return null;
                const filters = item.filters && typeof item.filters === 'object' ? item.filters : {};
                return {
                    id,
                    label,
                    icon: String(item.icon || '📁'),
                    filters: {
                        categories: Array.isArray(filters.categories) ? filters.categories.filter((category: unknown) => typeof category === 'string') : [],
                        soundOnly: Boolean(filters.soundOnly),
                        unreadOnly: Boolean(filters.unreadOnly),
                    },
                };
            })
            .filter(Boolean) as FolderDefinition[];
        return normalized.length ? normalized : DEFAULT_FOLDERS;
    } catch {
        return DEFAULT_FOLDERS;
    }
}

function persistFolderConfig(next: FolderDefinition[]) {
    localStorage.setItem(FOLDER_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event('unichat-folders-updated'));
}

function slugifyFolder(value: string) {
    const safe = value.toLowerCase().trim().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-+|-+$/g, '') || `folder-${Date.now()}`;
    return safe;
}

export default function SettingsPage() {
    const { section = 'profile' } = useParams();
    const navigate = useNavigate();
    const { i18n } = useTranslation();
    const user = useAuthStore((state) => state.user);
    const logout = useAuthStore((state) => state.logout);
    const setUser = useAuthStore((state) => state.setUser);
    const updateUser = useAuthStore((state) => state.updateUser);
    const selected = sections.find((item) => item.id === section) || sections[0];
    const [displayName, setDisplayName] = useState(user?.displayName || '');
    const [lastName, setLastName] = useState(user?.lastName || '');
    const [username, setUsername] = useState(user?.username || '');
    const [bio, setBio] = useState(user?.bio || '');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [profileError, setProfileError] = useState('');
    const [inviteFeedback, setInviteFeedback] = useState('');
    const [folders, setFolders] = useState<FolderDefinition[]>(() => getFolderConfig());
    const [folderName, setFolderName] = useState('');
    const [showFolderCreator, setShowFolderCreator] = useState(false);
    const [folderSearch, setFolderSearch] = useState('');
    const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
    const [folderSoundOnly, setFolderSoundOnly] = useState(false);
    const [folderUnreadOnly, setFolderUnreadOnly] = useState(false);
    const [folderMenuId, setFolderMenuId] = useState<string | null>(null);
    const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
    const [sessions, setSessions] = useState<DeviceSession[]>([]);
    const [notificationsEnabled, setNotificationsEnabled] = useState(() => readPreference('unichat-notifications', false));
    const [previewEnabled, setPreviewEnabled] = useState(() => readPreference('unichat-notification-preview', true));
    const [theme, setTheme] = useState(() => localStorage.getItem('unichat-theme') || 'system');
    const [chatTheme, setChatTheme] = useState(() => localStorage.getItem('unichat-chat-theme') || 'cosmos');
    const [chatFontSize, setChatFontSize] = useState(() => {
        const value = Number(localStorage.getItem('unichat-chat-font-size') || 2);
        return Number.isFinite(value) ? Math.max(0, Math.min(6, value)) : 2;
    });
    const avatarInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        document.documentElement.dataset.theme = theme === 'system'
            ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
            : theme;
    }, [theme]);

    useEffect(() => {
        document.documentElement.dataset.chatTheme = chatTheme;
        document.documentElement.style.setProperty('--chat-font-size', `${13 + chatFontSize}px`);
        localStorage.setItem('unichat-chat-theme', chatTheme);
        localStorage.setItem('unichat-chat-font-size', String(chatFontSize));
    }, [chatTheme, chatFontSize]);

    useEffect(() => {
        api.getMe().then(setUser).catch(() => navigate('/login'));
    }, []);

    useEffect(() => {
        setDisplayName(user?.displayName || '');
        setLastName(user?.lastName || '');
        setUsername(user?.username || '');
        setBio(user?.bio || '');
    }, [user?.displayName, user?.lastName, user?.username, user?.bio]);

    useEffect(() => {
        if (section === 'devices') api.getSessions().then(setSessions).catch(() => setSessions([]));
    }, [section]);

    useEffect(() => {
        const syncFolders = () => setFolders(getFolderConfig());
        window.addEventListener('unichat-folders-updated', syncFolders);
        return () => window.removeEventListener('unichat-folders-updated', syncFolders);
    }, []);

    const switchLanguage = (locale: 'ru' | 'en') => {
        i18n.changeLanguage(locale);
        localStorage.setItem('locale', locale);
        api.updateProfile({ locale }).catch(() => undefined);
    };

    const saveProfile = async (event: FormEvent) => {
        event.preventDefault();
        setSaving(true);
        setSaved(false);
        setProfileError('');
        try {
            const updated = await api.updateProfile({
                displayName: displayName.trim(),
                lastName: lastName.trim() || null,
                username: username.trim() || null,
                bio,
            });
            updateUser(updated);
            setSaved(true);
        } catch (error) {
            setProfileError(error instanceof Error ? error.message : 'Не удалось сохранить профиль');
        } finally {
            setSaving(false);
        }
    };

    const uploadAvatar = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setProfileError('');
        try {
            const result = await api.uploadAvatar(file);
            updateUser({ avatarUrl: result.avatarUrl });
        } catch (error) {
            setProfileError(error instanceof Error ? error.message : 'Не удалось загрузить фотографию');
        } finally {
            event.target.value = '';
        }
    };

    const cancelProfileEdit = () => {
        setDisplayName(user?.displayName || '');
        setLastName(user?.lastName || '');
        setUsername(user?.username || '');
        setBio(user?.bio || '');
        setProfileError('');
        setSaved(false);
    };

    const profileChanged = displayName !== (user?.displayName || '')
        || lastName !== (user?.lastName || '')
        || username !== (user?.username || '')
        || bio !== (user?.bio || '');

    const addFolder = (name: string, filters?: FolderDefinition['filters']) => {
        const cleaned = name.trim();
        if (!cleaned) return;
        const alreadyExists = folders.some((folder) => folder.label.toLowerCase() === cleaned.toLowerCase() || folder.id === slugifyFolder(cleaned));
        if (alreadyExists) return;
        const entry: FolderDefinition = {
            id: slugifyFolder(cleaned),
            label: cleaned,
            icon: '📁',
            filters: filters || { categories: [], soundOnly: false, unreadOnly: false },
        };
        const next = [...folders, entry];
        setFolders(next);
        persistFolderConfig(next);
        setFolderName('');
    };

    const openFolderCreator = (suggestedName = '') => {
        setFolderName(suggestedName);
        setFolderSearch('');
        setSelectedCategories(suggestedName === 'Личные' ? ['contacts'] : []);
        setFolderSoundOnly(false);
        setFolderUnreadOnly(false);
        setShowFolderCreator(true);
    };

    const createFolder = (event: FormEvent) => {
        event.preventDefault();
        addFolder(folderName, {
            categories: selectedCategories,
            soundOnly: folderSoundOnly,
            unreadOnly: folderUnreadOnly,
        });
        setShowFolderCreator(false);
    };

    const toggleFolderCategory = (category: string) => {
        setSelectedCategories((current) => current.includes(category)
            ? current.filter((item) => item !== category)
            : [...current, category]);
    };

    const moveFolder = (targetId: string) => {
        if (!draggedFolderId || draggedFolderId === targetId) return;
        setFolders((current) => {
            const next = [...current];
            const fromIndex = next.findIndex((folder) => folder.id === draggedFolderId);
            const toIndex = next.findIndex((folder) => folder.id === targetId);
            if (fromIndex < 0 || toIndex < 0) return current;
            const [moved] = next.splice(fromIndex, 1);
            next.splice(toIndex, 0, moved);
            persistFolderConfig(next);
            return next;
        });
        setDraggedFolderId(null);
    };

    const removeFolder = (id: string) => {
        if (DEFAULT_FOLDER_IDS.has(id)) return;
        const current = folders.filter((folder) => folder.id !== id);
        const safe = current.length ? current : DEFAULT_FOLDERS;
        setFolders(safe);
        persistFolderConfig(safe);
    };

    const toggleNotifications = async () => {
        if (!notificationsEnabled && 'Notification' in window && Notification.permission === 'default') {
            await Notification.requestPermission();
        }
        const enabled = !notificationsEnabled;
        setNotificationsEnabled(enabled);
        localStorage.setItem('unichat-notifications', String(enabled));
    };

    const saveTheme = (value: string) => {
        setTheme(value);
        localStorage.setItem('unichat-theme', value);
    };

    const saveChatTheme = (value: string) => setChatTheme(value);

    const revokeSession = async (id: string) => {
        await api.revokeSession(id);
        setSessions((current) => current.filter((session) => session.id !== id));
    };

    const inviteFriends = async () => {
        try {
            if (navigator.share) await navigator.share({ title: 'UniChat', url: window.location.origin });
            else {
                await navigator.clipboard.writeText(window.location.origin);
                setInviteFeedback('Ссылка скопирована');
            }
        } catch (error) {
            if (error instanceof Error && error.name !== 'AbortError') setInviteFeedback('Не удалось поделиться ссылкой');
        }
    };

    const signOut = async () => {
        try { await api.logout(); } catch { /* The local session must still be cleared. */ }
        logout();
        navigate('/login');
    };

    return (
        <main className="settings-page">
            <aside className="settings-sidebar">
                <header className="settings-sidebar-heading">
                    <button className="btn-icon settings-back" onClick={() => navigate('/chat')} title="Назад в чаты">←</button>
                    <h1>Настройки</h1>
                </header>
                <button className={`settings-account ${section === 'profile' ? 'active' : ''}`} onClick={() => navigate('/settings/profile')}>
                    <span className="settings-account-avatar">{user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : '👤'}</span>
                    <span><strong>{user?.displayName || 'Ваш профиль'}{user?.isVerified && <VerifiedBadge />}</strong><small>{user?.phone || ''}</small></span>
                    <span className="settings-chevron">›</span>
                </button>
                <nav className="settings-navigation" aria-label="Разделы настроек">
                    {sections.slice(1).filter((item) => item.id !== 'admin' || user?.isAdmin).map((item) => (
                        <button key={item.id} className={`settings-nav-item ${section === item.id ? 'active' : ''}`} onClick={() => navigate(`/settings/${item.id}`)}>
                            <span className="settings-nav-icon">{item.icon}</span><span>{item.title}</span><span className="settings-chevron">›</span>
                        </button>
                    ))}
                </nav>
            </aside>

            <section className="settings-content">
                <header className="settings-topbar">
                    <button className="btn-icon settings-mobile-back" onClick={() => navigate('/settings/profile')} title="Назад">←</button>
                    <strong>{section === 'profile' ? 'Редактировать профиль' : selected.title}</strong>
                </header>
                <div className="settings-body">
                    {section === 'profile' && (
                        <form className="settings-form" onSubmit={saveProfile}>
                            <button className="settings-avatar-button" type="button" onClick={() => avatarInputRef.current?.click()} title="Изменить аватар">
                                <span className="settings-profile-avatar">{user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : '👤'}</span>
                                <span className="settings-avatar-camera">📷</span>
                            </button>
                            <input ref={avatarInputRef} className="settings-avatar-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={uploadAvatar} />
                            <label className="settings-field"><span>Имя</span><input className="input" value={displayName} maxLength={64} required onChange={(event) => setDisplayName(event.target.value)} /></label>
                            <label className="settings-field"><span>Фамилия</span><input className="input" value={lastName} maxLength={64} onChange={(event) => setLastName(event.target.value)} /></label>
                            <label className="settings-field"><span>@username</span><input className="input" value={username} maxLength={32} placeholder="username" onChange={(event) => setUsername(event.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} /></label>
                            <label className="settings-field"><span>О себе</span><textarea className="input" value={bio} maxLength={500} rows={4} onChange={(event) => setBio(event.target.value)} /></label>
                            {profileError && <p className="settings-error" role="alert">{profileError}</p>}
                            {saved && <p className="settings-status" role="status">Изменения сохранены</p>}
                            {profileChanged && <div className="settings-form-actions">
                                <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Сохранение...' : 'Сохранить'}</button>
                                <button className="btn btn-secondary" type="button" disabled={saving} onClick={cancelProfileEdit}>Отмена</button>
                            </div>}
                            <button className="btn btn-secondary" type="button" onClick={signOut}>Выйти из профиля</button>
                        </form>
                    )}

                    {section === 'folders' && (
                        <div className="settings-section-body folder-settings">
                            <section className="folder-card">
                                <div className="folder-intro">
                                    <div className="folder-intro-icon">📁</div>
                                    <p>Создавайте папки для чатов<br />и легко переключайтесь между ними</p>
                                    <button className="btn btn-primary folder-create-button" onClick={() => openFolderCreator()}><span>＋</span> Создать папку</button>
                                </div>
                                <div className="folder-card-divider" />
                                <h3 className="folder-card-title">Ваши папки</h3>
                                {folders.map((folder) => (
                                    <div
                                        className={`folder-row ${draggedFolderId === folder.id ? 'dragging' : ''}`}
                                        key={folder.id}
                                        draggable
                                        onDragStart={() => setDraggedFolderId(folder.id)}
                                        onDragEnd={() => setDraggedFolderId(null)}
                                        onDragOver={(event) => event.preventDefault()}
                                        onDrop={() => moveFolder(folder.id)}
                                    >
                                        <span className="folder-row-icon">{folder.icon}</span>
                                        <strong>{folder.label}</strong>
                                        {folder.id !== 'all' && <button className="folder-drag-handle" title="Перетащить папку">☰</button>}
                                        {folder.id !== 'all' && <div className="folder-row-menu-wrap">
                                            <button className="folder-more-button" title="Действия с папкой" onClick={() => setFolderMenuId(folderMenuId === folder.id ? null : folder.id)}>⋮</button>
                                            {folderMenuId === folder.id && <div className="folder-row-menu"><button onClick={() => {
                                                if (DEFAULT_FOLDER_IDS.has(folder.id)) {
                                                    setFolders(DEFAULT_FOLDERS);
                                                    persistFolderConfig(DEFAULT_FOLDERS);
                                                } else removeFolder(folder.id);
                                                setFolderMenuId(null);
                                            }}>{DEFAULT_FOLDER_IDS.has(folder.id) ? 'Сбросить порядок' : 'Удалить папку'}</button></div>}
                                        </div>}
                                    </div>
                                ))}
                            </section>
                            <section className="folder-card folder-recommended">
                                <h3 className="folder-card-title">Рекомендованные папки</h3>
                                {!folders.some((folder) => folder.label.toLowerCase() === 'личные') && <div className="folder-row recommended-row"><strong>Личные</strong><button className="folder-add-recommended" title="Добавить папку «Личные»" onClick={() => openFolderCreator('Личные')}>＋</button></div>}
                            </section>
                        </div>
                    )}

                    {section === 'security' && (
                        <div className="settings-section-body">
                            <h3 className="settings-subheading">Безопасность аккаунта</h3>
                            <div className="settings-list-row"><span><strong>Номер телефона</strong><small>{user?.phone}</small></span><span className="settings-status">Подтверждён</span></div>
                            <div className="settings-list-row"><span><strong>Активные сеансы</strong><small>Управляйте устройствами, где открыт аккаунт</small></span><button className="btn btn-secondary" onClick={() => navigate('/settings/devices')}>Открыть</button></div>
                            <p className="settings-description">Код подтверждения отправляется на номер телефона при каждом входе.</p>
                        </div>
                    )}

                    {section === 'devices' && (
                        <div className="settings-section-body">
                            <h3 className="settings-subheading">Активные сеансы</h3>
                            {!sessions.length && <p className="settings-empty">Нет других активных сеансов</p>}
                            {sessions.map((session) => <div className="settings-list-row" key={session.id}><span><strong>{session.userAgent || 'Устройство'}</strong><small>{session.ipAddress || 'Адрес недоступен'} · {new Date(session.createdAt).toLocaleDateString()}</small></span><button className="btn btn-secondary" onClick={() => revokeSession(session.id)}>Завершить</button></div>)}
                        </div>
                    )}

                    {section === 'notifications' && (
                        <div className="settings-section-body">
                            <h3 className="settings-subheading">Уведомления в браузере</h3>
                            <label className="settings-toggle-row"><span><strong>Уведомления о сообщениях</strong><small>Показывать новые сообщения, когда сайт неактивен</small></span><input type="checkbox" checked={notificationsEnabled} onChange={toggleNotifications} /></label>
                            <label className="settings-toggle-row"><span><strong>Предпросмотр сообщений</strong><small>Показывать текст сообщения в уведомлении</small></span><input type="checkbox" checked={previewEnabled} onChange={(event) => { setPreviewEnabled(event.target.checked); localStorage.setItem('unichat-notification-preview', String(event.target.checked)); }} /></label>
                            {'Notification' in window && Notification.permission === 'denied' && <p className="settings-description">Уведомления запрещены в настройках браузера. Разрешите их для этого сайта.</p>}
                        </div>
                    )}

                    {section === 'appearance' && (
                        <div className="settings-section-body appearance-settings">
                            <label className="appearance-control-label" htmlFor="chat-font-size">РАЗМЕР ТЕКСТА</label>
                            <div className="appearance-size-control">
                                <span className="appearance-size-small">A</span>
                                <input id="chat-font-size" type="range" min="0" max="6" step="1" value={chatFontSize} style={{ ['--range-progress' as any]: `${(chatFontSize / 6) * 100}%` }} onChange={(event) => setChatFontSize(Number(event.target.value))} aria-label="Размер текста" />
                                <span className="appearance-size-large">A</span>
                            </div>

                            <label className="appearance-control-label">ТЕМА</label>
                            <div className="appearance-mode-control" role="group" aria-label="Режим темы">
                                {([['system', 'Системная'], ['light', 'Светлая'], ['dark', 'Тёмная']] as const).map(([value, label]) => (
                                    <button className={theme === value ? 'active' : ''} key={value} aria-pressed={theme === value} onClick={() => saveTheme(value)}>{label}</button>
                                ))}
                            </div>

                            <label className="appearance-control-label appearance-preview-label">ТЕМА ОФОРМЛЕНИЯ</label>
                            <div className={`appearance-preview ${chatTheme}`}>
                                <div className="appearance-preview-messages" style={{ fontSize: 'var(--chat-font-size)' }}>
                                    <div className="appearance-preview-message incoming"><span>Знаешь,который час?</span><small>09:00</small></div>
                                    <div className="appearance-preview-message outgoing"><span>В Амстердаме утро</span><small>09:00 ✓</small></div>
                                </div>
                            </div>

                            <div className="appearance-theme-scroller" aria-label="Темы оформления">
                                {CHAT_THEMES.map((item) => (
                                    <button className={`appearance-theme-option ${item.id} ${chatTheme === item.id ? 'selected' : ''}`} key={item.id} aria-pressed={chatTheme === item.id} onClick={() => saveChatTheme(item.id)}>
                                        <span className="appearance-theme-swatch"><span /><span /></span>
                                        <span className="appearance-theme-name">{item.label}</span>
                                    </button>
                                ))}
                            </div>

                            <p className="appearance-description">При выборе темы изменяются основные цвета, чаты и системные элементы. Изменения темы не синхронизируются между устройствами.</p>
                        </div>
                    )}

                    {section === 'language' && (
                        <div className="settings-section-body">
                            <div className="settings-choice-list">{([['ru', 'Русский'], ['en', 'English']] as const).map(([value, label]) => <label className="settings-choice" key={value}><span>{label}</span><input type="radio" name="language" checked={i18n.language === value} onChange={() => switchLanguage(value)} /></label>)}</div>
                            <p className="settings-description">Язык изменится только на этом устройстве.</p>
                        </div>
                    )}

                    {section === 'premium' && (
                        <div className="settings-section-body settings-premium">
                            <div className="settings-premium-mark">⭐</div>
                            <h2>UniChat Premium</h2>
                            <p className="settings-description">Больше возможностей для общения и персонализации.</p>
                            <ul><li>Больше места для файлов</li><li>Дополнительные темы оформления</li><li>Расширенные настройки профиля</li></ul>
                            <p className="settings-empty">Подписка Premium скоро появится.</p>
                            <button className="btn btn-primary" disabled>Скоро</button>
                        </div>
                    )}

                    {section === 'invite' && (
                        <div className="settings-section-body">
                            <h3 className="settings-subheading">Пригласить друзей в UniChat</h3>
                            <p className="settings-description">Поделитесь ссылкой на UniChat с друзьями.</p>
                            <button className="btn btn-primary" onClick={inviteFriends}>🔗 Поделиться ссылкой</button>
                            {inviteFeedback && <p className="settings-status" role="status">{inviteFeedback}</p>}
                        </div>
                    )}

                    {section === 'about' && (
                        <div className="settings-section-body">
                            <h2>UniChat</h2>
                            <p className="settings-description">Версия 1.0.0</p>
                            <p>Приватные и групповые чаты, обмен файлами и голосовыми сообщениями.</p>
                        </div>
                    )}

                    {section === 'admin' && user?.isAdmin && (
                        <div className="settings-section-body">
                            <h2>Админ-панель</h2>
                            <p className="settings-description">Управление UniChat доступно в отдельном разделе.</p>
                            <button className="btn btn-primary" onClick={() => navigate('/admin')}>Открыть админ-панель</button>
                        </div>
                    )}
                </div>
            </section>
            {showFolderCreator && <div className="folder-creator-overlay">
                <header className="folder-creator-header">
                    <button className="btn-icon" type="button" onClick={() => setShowFolderCreator(false)} title="Назад">←</button>
                    <strong>Новая папка</strong>
                    <span />
                </header>
                <form className="folder-creator-form" onSubmit={createFolder}>
                    <section className="folder-creator-card folder-name-card">
                        <label htmlFor="folder-name">Название</label>
                        <div className="folder-name-input-wrap">
                            <input id="folder-name" className="input" value={folderName} maxLength={20} placeholder="Название папки" onChange={(event) => setFolderName(event.target.value)} autoFocus />
                            <small>{folderName.length}/20</small>
                        </div>
                    </section>
                    <section className="folder-creator-card folder-category-card">
                        <label className="folder-search"><span>⌕</span><input value={folderSearch} placeholder="Найти по имени" onChange={(event) => setFolderSearch(event.target.value)} /></label>
                        <div className="folder-category-list">
                            {folderCategories.filter((category) => category.label.toLowerCase().includes(folderSearch.toLowerCase())).map((category, index, filtered) => (
                                <div key={category.id}>
                                    {(index === 0 || filtered[index - 1].group !== category.group) && <h3 className="folder-category-heading">{category.group}</h3>}
                                    <button type="button" className={`folder-category-option ${selectedCategories.includes(category.id) ? 'selected' : ''}`} aria-pressed={selectedCategories.includes(category.id)} onClick={() => toggleFolderCategory(category.id)}>
                                        <span className={`folder-category-icon ${category.id === 'saved' ? 'saved' : ''}`}>{category.icon}</span>
                                        <span className="folder-category-label"><strong>{category.label}</strong>{category.description && <small>{category.description}</small>}</span>
                                        <span className="folder-radio" />
                                    </button>
                                </div>
                            ))}
                            {!folderCategories.some((category) => category.label.toLowerCase().includes(folderSearch.toLowerCase())) && <p className="settings-empty">Ничего не найдено</p>}
                        </div>
                    </section>
                    <div className="folder-filter-caption">ПОКАЗЫВАТЬ ТОЛЬКО</div>
                    <section className="folder-creator-card folder-toggle-card">
                        <label className="folder-toggle-row"><span>♧</span><strong>Чаты со звуком</strong><input type="checkbox" checked={folderSoundOnly} onChange={(event) => setFolderSoundOnly(event.target.checked)} /></label>
                        <label className="folder-toggle-row"><span>▣</span><strong>Непрочитанные чаты</strong><input type="checkbox" checked={folderUnreadOnly} onChange={(event) => setFolderUnreadOnly(event.target.checked)} /></label>
                    </section>
                    <footer className="folder-creator-actions">
                        <button className="btn btn-secondary" type="button" onClick={() => { setSelectedCategories([]); setFolderSoundOnly(false); setFolderUnreadOnly(false); }}>Очистить выбор</button>
                        <button className="btn btn-primary" type="submit" disabled={!folderName.trim()}>Создать папку</button>
                    </footer>
                </form>
            </div>}
        </main>
    );
}