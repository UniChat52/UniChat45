import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { socketService } from '../services/socket';
import { useAuthStore } from '../store/auth';
import { useChatStore } from '../store/chat';
import VerifiedBadge from '../components/VerifiedBadge';

type PhonebookContact = { name: string; phone: string };
type PhonebookAccount = { id: string; phone: string; username: string | null; displayName: string | null; avatarUrl: string | null; isVerified: boolean };
type ContactPickerRecord = { name?: string[]; tel?: string[] };
type ContactPickerNavigator = Navigator & {
    contacts?: { select: (properties: string[], options: { multiple: boolean }) => Promise<ContactPickerRecord[]> };
};

const PHONEBOOK_STORAGE_PREFIX = 'unichat-phonebook:';

function normalizeContactPhone(phone: string) {
    return phone.replace(/[^\d+]/g, '');
}

function parseVCard(contents: string): PhonebookContact[] {
    const unfolded = contents.replace(/\r?\n[ \t]/g, '');
    const cards = unfolded.split(/BEGIN:VCARD/i).slice(1).map((card) => card.split(/END:VCARD/i)[0]);
    const contacts: PhonebookContact[] = [];
    const decode = (value: string) => value.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();

    for (const card of cards) {
        let name = '';
        let structuredName = '';
        const phones: string[] = [];
        for (const line of card.split(/\r?\n/)) {
            const separator = line.indexOf(':');
            if (separator < 0) continue;
            const property = line.slice(0, separator).split(';')[0].toUpperCase();
            const value = decode(line.slice(separator + 1));
            if (property === 'FN') name = value;
            if (property === 'N') {
                const parts = value.split(';');
                structuredName = [parts[1], parts[0]].filter(Boolean).join(' ');
            }
            if (property === 'TEL') phones.push(value);
        }
        const contactName = name || structuredName;
        for (const phone of phones) {
            const normalizedPhone = normalizeContactPhone(phone);
            if (normalizedPhone.replace(/\D/g, '').length >= 6) contacts.push({ name: contactName || normalizedPhone, phone: normalizedPhone });
        }
    }

    return contacts;
}

// ── Helpers ──
function formatTime(dateStr: string) {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatLastSeen(dateStr: string | null | undefined) {
    if (!dateStr) return 'давно не в сети';
    const date = new Date(dateStr);
    const now = new Date();
    const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (date.toDateString() === now.toDateString()) return `был(а) в сети сегодня в ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `был(а) в сети вчера в ${time}`;
    return `был(а) в сети ${date.toLocaleDateString('ru-RU')} в ${time}`;
}

function formatDate(dateStr: string) {
    const d = new Date(dateStr);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Сегодня';
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
    return d.toLocaleDateString();
}

function getInitials(name: string | null | undefined): string {
    if (!name) return '?';
    return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
}

function getAvatarClass(id: string): string {
    const num = (id.charCodeAt(0) + id.charCodeAt(id.length - 1)) % 7 + 1;
    return `avatar-gradient-${num}`;
}

function isChatIdentityVerified(chat: any, currentUserId?: string) {
    if (chat?.type === 'CHANNEL') return Boolean(chat.isVerified);
    if (chat?.type !== 'PRIVATE') return false;
    const otherMember = chat.members?.find((member: any) => member.userId !== currentUserId);
    return Boolean(otherMember?.user?.isVerified);
}

function formatFileSize(bytes: number | null): string {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

type FolderDefinition = { id: string; label: string; icon: string; filters?: { categories: string[]; soundOnly: boolean; unreadOnly: boolean } };

const FOLDER_STORAGE_KEY = 'unichat-folder-order';
const DEFAULT_FOLDERS: FolderDefinition[] = [
    { id: 'all', label: 'Все', icon: '💬', filters: { categories: [], soundOnly: false, unreadOnly: false } },
    { id: 'new', label: 'Новые', icon: '📁', filters: { categories: [], soundOnly: false, unreadOnly: true } },
    { id: 'channels', label: 'Каналы', icon: '📁', filters: { categories: ['channels'], soundOnly: false, unreadOnly: false } },
];

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

// ── Voice Player Component ──
function VoicePlayer({ src }: { src: string }) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [maxTime, setMaxTime] = useState(0); // track max currentTime for Infinity duration
    const [error, setError] = useState<string | null>(null);
    const [waveform] = useState(() =>
        Array.from({ length: 28 }, () => 8 + Math.random() * 24)
    );

    const togglePlay = () => {
        const audio = audioRef.current;
        if (!audio) return;
        if (error) {
            // Retry on error
            setError(null);
            audio.load();
            audio.play().catch((err) => {
                console.error('🔊 Audio play error:', err);
                setError(err.message);
            });
            return;
        }
        if (isPlaying) {
            audio.pause();
        } else {
            audio.play().catch((err) => {
                console.error('🔊 Audio play error:', err);
                setError(err.message);
            });
        }
    };

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        const onPlay = () => { console.log('🔊 Playing:', src); setIsPlaying(true); };
        const onPause = () => setIsPlaying(false);
        const onEnded = () => {
            setIsPlaying(false);
            // When ended, currentTime is the real duration for WebM (which reports Infinity)
            if (!isFinite(duration) || duration === 0) {
                setDuration(audio.currentTime || maxTime);
            }
            setCurrentTime(0);
        };
        const onTimeUpdate = () => {
            const t = audio.currentTime;
            setCurrentTime(t);
            if (t > maxTime) setMaxTime(t);
        };
        const onLoadedMetadata = () => {
            const d = audio.duration;
            console.log('🔊 Audio loaded, duration:', d, 'src:', src);
            if (isFinite(d) && d > 0) {
                setDuration(d);
            }
        };
        const onDurationChange = () => {
            const d = audio.duration;
            if (isFinite(d) && d > 0) {
                setDuration(d);
            }
        };
        const onError = () => {
            const e = audio.error;
            console.error('🔊 Audio error:', e?.code, e?.message, 'src:', src);
            setError(`Audio error: ${e?.message || 'unknown'}`);
        };

        audio.addEventListener('play', onPlay);
        audio.addEventListener('pause', onPause);
        audio.addEventListener('ended', onEnded);
        audio.addEventListener('timeupdate', onTimeUpdate);
        audio.addEventListener('loadedmetadata', onLoadedMetadata);
        audio.addEventListener('durationchange', onDurationChange);
        audio.addEventListener('error', onError);

        return () => {
            audio.removeEventListener('play', onPlay);
            audio.removeEventListener('pause', onPause);
            audio.removeEventListener('ended', onEnded);
            audio.removeEventListener('timeupdate', onTimeUpdate);
            audio.removeEventListener('loadedmetadata', onLoadedMetadata);
            audio.removeEventListener('durationchange', onDurationChange);
            audio.removeEventListener('error', onError);
        };
    }, [src]);

    // For WebM with Infinity duration, use currentTime for progress
    const effectiveDuration = (isFinite(duration) && duration > 0) ? duration : maxTime || 0;
    const progress = effectiveDuration > 0 ? (currentTime / effectiveDuration) * 100 : 0;
    const activeBars = Math.floor((progress / 100) * waveform.length);

    const handleBarClick = (index: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        // Only allow seeking if we have a finite duration
        if (isFinite(duration) && duration > 0) {
            audio.currentTime = (index / waveform.length) * duration;
        }
    };

    const displayTime = isPlaying
        ? formatDuration(currentTime)
        : effectiveDuration > 0 ? formatDuration(effectiveDuration) : '0:00';

    return (
        <div className="voice-player">
            <audio ref={audioRef} src={src} preload="auto" />
            <button className="voice-play-btn" onClick={togglePlay} type="button">
                {error ? '⚠️' : isPlaying ? '⏸' : '▶'}
            </button>
            <div className="voice-waveform">
                {waveform.map((h: number, i: number) => (
                    <div
                        key={i}
                        className={`voice-bar ${i < activeBars ? 'active' : ''}`}
                            style={{ height: `${h}px` }}
                            onClick={() => handleBarClick(i)}
                        />
                ))}
            </div>
            <span className="voice-duration">
                {displayTime}
            </span>
        </div>
    );
}

// ── Profile Panel Component ──
function ProfilePanel({
    user,
    onClose,
    onUpdate,
}: {
    user: any;
    onClose: () => void;
    onUpdate: (data: any) => void;
}) {
    const { t } = useTranslation();
    const [displayName, setDisplayName] = useState(user?.displayName || '');
    const [username, setUsername] = useState(user?.username || '');
    const [bio, setBio] = useState(user?.bio || '');
    const [saving, setSaving] = useState(false);
    const avatarInputRef = useRef<HTMLInputElement>(null);

    const handleSave = async () => {
        setSaving(true);
        try {
            const updated = await api.updateProfile({ displayName, username, bio });
            onUpdate(updated);
        } catch (err: any) {
            console.error('Profile save failed:', err);
        } finally {
            setSaving(false);
        }
    };

    const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const result = await api.uploadAvatar(file);
            onUpdate({ avatarUrl: result.avatarUrl });
        } catch (err: any) {
            console.error('Avatar upload failed:', err);
        }
        e.target.value = '';
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
                <div className="profile-modal-header">
                    <h3>👤 {t('profile.edit')} {user?.isVerified && <VerifiedBadge />}</h3>
                    <button className="btn-icon" onClick={onClose}>✕</button>
                </div>

                <div className="profile-avatar-section">
                    <div
                        className={`avatar avatar-xl ${getAvatarClass(user?.id || 'x')} profile-avatar-clickable`}
                        onClick={() => avatarInputRef.current?.click()}
                    >
                        {user?.avatarUrl ? (
                            <img src={user.avatarUrl} alt="" />
                        ) : (
                            getInitials(user?.displayName || user?.username)
                        )}
                        <div className="avatar-overlay">📷</div>
                    </div>
                    <input
                        ref={avatarInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        style={{ display: 'none' }}
                        onChange={handleAvatarUpload}
                    />
                    <p className="profile-avatar-hint">{t('profile.setup')}</p>
                    {user?.isVerified && <p className="profile-verification"><VerifiedBadge /> Верифицированный аккаунт</p>}
                </div>

                <div className="input-group">
                    <label className="input-label">{t('profile.displayName')}</label>
                    <input
                        className="input"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Ваше имя"
                    />
                </div>

                <div className="input-group">
                    <label className="input-label">{t('profile.username')}</label>
                    <input
                        className="input"
                        value={username}
                        onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32))}
                        placeholder="username"
                    />
                </div>

                <div className="input-group">
                    <label className="input-label">{t('profile.bio')}</label>
                    <textarea
                        className="input"
                        value={bio}
                        onChange={(e) => setBio(e.target.value.slice(0, 200))}
                        placeholder="О себе..."
                        rows={3}
                        style={{ resize: 'vertical' }}
                    />
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'right', marginTop: 4 }}>
                        {bio.length}/200
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
                    <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                        {saving ? '...' : t('profile.save')}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ══════════════════════════════════════════════
// ── MAIN CHAT PAGE ──
// ══════════════════════════════════════════════
export default function ChatPage() {
    const { t } = useTranslation();
    const { chatId } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams] = useSearchParams();

    const user = useAuthStore((s) => s.user);
    const logout = useAuthStore((s) => s.logout);
    const setUser = useAuthStore((s) => s.setUser);
    const updateUser = useAuthStore((s) => s.updateUser);

    const {
        chats, setChats, activeChat, setActiveChat,
        messages, setMessages, addMessage, updateMessage, deleteMessage,
        typingUsers, setTyping, setUserOnline, onlineUsers, lastSeenByUser,
        upsertChat, updateChatMeta, removeChat, setMessageReactions, setMessagePinned,
    } = useChatStore();

    const [messageText, setMessageText] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [showNewChat, setShowNewChat] = useState(false);
    const [showNewGroup, setShowNewGroup] = useState(false);
    const [showNewChannel, setShowNewChannel] = useState(false);
    const [showCreateMenu, setShowCreateMenu] = useState(false);
    const [showContactsMenu, setShowContactsMenu] = useState(false);
    const [showCallMenu, setShowCallMenu] = useState(false);
    const [callTab, setCallTab] = useState<'all' | 'missed'>('all');
    const [callSelectionMode, setCallSelectionMode] = useState(false);
    const [listSearch, setListSearch] = useState('');
    const [contactSearchTitle, setContactSearchTitle] = useState('Новый чат');
    const [contactSearchPlaceholder, setContactSearchPlaceholder] = useState('Поиск пользователей...');
    const [sidebarFeedback, setSidebarFeedback] = useState('');
    const [phoneContacts, setPhoneContacts] = useState<PhonebookContact[]>([]);
    const [matchedPhoneContacts, setMatchedPhoneContacts] = useState<Record<string, PhonebookAccount>>({});
    const [phonebookLoading, setPhonebookLoading] = useState(false);
    const [phonebookError, setPhonebookError] = useState('');
    const [groupName, setGroupName] = useState('');
    const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
    const [showProfile, setShowProfile] = useState(false);
    const [incomingNotice, setIncomingNotice] = useState<any>(null);
    const [replyTo, setReplyTo] = useState<any>(null);
    const [isRecording, setIsRecording] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const [folderConfig, setFolderConfig] = useState<FolderDefinition[]>(() => getFolderConfig());
    const [activeFolder, setActiveFolder] = useState<string>(() => new URLSearchParams(window.location.search).get('folder') || 'all');
    const [socketReady, setSocketReady] = useState(false);
    const [readOnly, setReadOnly] = useState(false);
    const [readAtByMember, setReadAtByMember] = useState<Record<string, string>>({});
    const [messageMenu, setMessageMenu] = useState<{ message: any; x: number; y: number } | null>(null);
    const [forwardingMessage, setForwardingMessage] = useState<any>(null);
    const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
    const [readReceipts, setReadReceipts] = useState<{ name: string; read: boolean; lastReadAt: string | null; isVerified: boolean }[] | null>(null);

    const chatLoadSequenceRef = useRef(0);
    const messagePressTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const phonebookFileInputRef = useRef<HTMLInputElement>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const typingTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
    const recordingTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const noticeTimerRef = useRef<ReturnType<typeof setTimeout>>();

    const scrollToLatest = (behavior: ScrollBehavior = 'smooth') => requestAnimationFrame(() => {
        const container = messagesContainerRef.current;
        if (container) container.scrollTo({ top: container.scrollHeight, behavior });
    });

    // ── STEP 1: Connect socket FIRST, then fetch data ──
    useEffect(() => {
        const token = localStorage.getItem('accessToken');
        if (token) {
            socketService.connect(token);
        }

        // Small delay to let socket establish, then fetch data
        const fetchData = async () => {
            try {
                const systemStatus = await api.getSystemStatus();
                setReadOnly(Boolean(systemStatus.readOnly));
                const me = await api.getMe();
                setUser(me);
                const chatList = await api.getChats();
                setChats(chatList);
                chatList.forEach((chat: any) => chat.members?.forEach((member: any) => {
                    setUserOnline(member.userId, Boolean(member.user?.isOnline), member.user?.lastSeenAt);
                }));
                // Mark socket as ready AFTER connection and data load
                setSocketReady(true);
            } catch {
                logout();
                navigate('/login');
            }
        };
        fetchData();

        return () => {
            socketService.removeAllListeners();
            socketService.disconnect();
        };
    }, []);

    // ── STEP 2: Attach socket listeners only when socket is ready and user is loaded ──
    useEffect(() => {
        if (!socketReady || !user?.id) return;

        const handleNewMessage = (message: any) => {
            console.log('📩 New message received:', message.id);
            addMessage(message);
            const senderId = message.senderId || message.sender?.id;
            const chat = chats.find((item) => item.id === message.chatId);
            if (message.chatId === chatId && senderId === user.id) scrollToLatest();
            if (message.chatId === chatId && senderId !== user.id && document.visibilityState === 'visible' && document.hasFocus()) {
                socketService.markRead(message.chatId);
                updateChatMeta({ id: message.chatId, unreadCount: 0 });
            } else if (senderId !== user.id && chat) {
                updateChatMeta({ id: message.chatId, unreadCount: (chat.unreadCount || 0) + 1 });
            }
            if (senderId === user.id || message.chatId === chatId) return;

            const title = chat?.name || message.sender?.displayName || 'Новое сообщение';
            const body = localStorage.getItem('unichat-notification-preview') === 'false'
                ? 'Новое сообщение'
                : (message.content || 'Вложение');

            if (document.hidden && localStorage.getItem('unichat-notifications') === 'true' && 'Notification' in window && Notification.permission === 'granted') {
                const notification = new Notification(title, { body, tag: message.chatId });
                notification.onclick = () => {
                    window.focus();
                    navigate(`/chat/${message.chatId}`);
                    notification.close();
                };
                return;
            }

            setIncomingNotice({ chatId: message.chatId, title, body });
            if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
            noticeTimerRef.current = setTimeout(() => setIncomingNotice(null), 5000);
        };
        const handleTypingStart = (data: any) => {
            if (data.userId !== user.id) setTyping(data.chatId, data.userId, true);
        };
        const handleTypingStop = (data: any) => setTyping(data.chatId, data.userId, false);
        const handleMessageEdited = (message: any) => updateMessage(message);
        const handleMessageDeleted = (data: any) => deleteMessage(data.chatId, data.messageId);
        const handleMessageReactions = (data: any) => setMessageReactions(data.chatId, data.messageId, data.reactions);
        const handleMessagePinned = (data: any) => setMessagePinned(data.chatId, data.id, data.pinnedAt);
        const handleMessageRead = (data: { chatId: string; userId: string; readAt: string }) => {
            setReadAtByMember((current) => ({ ...current, [`${data.chatId}:${data.userId}`]: data.readAt }));
        };
        const handleSystemReadOnly = (data: { enabled: boolean; allowedUserIds?: string[] }) => {
            setReadOnly(data.enabled && user.username !== 'vaksik14' && !(data.allowedUserIds || []).includes(user.id));
        };
        const handleSystemMaintenance = (data: { enabled: boolean }) => {
            if (data.enabled) window.location.reload();
        };
        const handleUserStatus = (data: any) => setUserOnline(data.userId, data.isOnline, data.lastSeen);
        const handleChatCreated = (chat: any) => {
            upsertChat(chat);
            if (chat.id) socketService.joinChat(chat.id);
        };
        const handleChatUpdated = (data: any) => {
            if (data?.id) {
                upsertChat(data);
                return;
            }
            if (!data || !data.chatId) return;
            const chat = chats.find((c) => c.id === data.chatId);
            if (chat) {
                updateChatMeta({ id: data.chatId, updatedAt: new Date().toISOString(), name: chat.name || undefined });
            }
        };
        const handleChatRemoved = (data: { chatId: string }) => removeChat(data.chatId);

        socketService.onNewMessage(handleNewMessage);
        socketService.onTypingStart(handleTypingStart);
        socketService.onTypingStop(handleTypingStop);
        socketService.onMessageEdited(handleMessageEdited);
        socketService.onMessageDeleted(handleMessageDeleted);
        socketService.onMessageReactions(handleMessageReactions);
        socketService.onMessagePinned(handleMessagePinned);
        socketService.onMessageRead(handleMessageRead);
        socketService.onSystemReadOnly(handleSystemReadOnly);
        socketService.onSystemMaintenance(handleSystemMaintenance);
        socketService.onUserStatus(handleUserStatus);
        socketService.onChatCreated(handleChatCreated);
        socketService.onChatUpdated(handleChatUpdated);
        socketService.onChatRemoved(handleChatRemoved);

        return () => {
            if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
            socketService.offNewMessage(handleNewMessage);
            socketService.offTypingStart(handleTypingStart);
            socketService.offTypingStop(handleTypingStop);
            socketService.offMessageEdited(handleMessageEdited);
            socketService.offMessageDeleted(handleMessageDeleted);
            socketService.offMessageReactions(handleMessageReactions);
            socketService.offMessagePinned(handleMessagePinned);
            socketService.offMessageRead(handleMessageRead);
            socketService.offSystemReadOnly(handleSystemReadOnly);
            socketService.offSystemMaintenance(handleSystemMaintenance);
            socketService.offUserStatus(handleUserStatus);
            socketService.offChatCreated(handleChatCreated);
            socketService.offChatUpdated(handleChatUpdated);
            socketService.offChatRemoved(handleChatRemoved);
        };
    }, [socketReady, user?.id, chats, chatId]);

    // ── Load chat when chatId changes ──
    useEffect(() => {
        if (chatId) loadChat(chatId);
        else {
            chatLoadSequenceRef.current++;
            setActiveChat(null);
        }
    }, [chatId]);

    useEffect(() => {
        if (!chatId || activeChat?.id !== chatId || !socketReady) return;
        const markReadWhenVisible = () => {
            if (document.visibilityState === 'visible' && document.hasFocus()) {
                socketService.markRead(chatId);
                updateChatMeta({ id: chatId, unreadCount: 0 });
            }
        };
        document.addEventListener('visibilitychange', markReadWhenVisible);
        window.addEventListener('focus', markReadWhenVisible);
        markReadWhenVisible();
        return () => {
            document.removeEventListener('visibilitychange', markReadWhenVisible);
            window.removeEventListener('focus', markReadWhenVisible);
        };
    }, [chatId, activeChat?.id, socketReady]);

    useLayoutEffect(() => {
        if (!chatId || activeChat?.id !== chatId) return;
        scrollToLatest('auto');
    }, [chatId, activeChat?.id]);

    useEffect(() => {
        setShowCreateMenu(false);
        setShowContactsMenu(false);
        setShowCallMenu(false);
    }, [location.pathname, location.search]);

    useEffect(() => {
        const folder = searchParams.get('folder');
        if (folder && (folderConfig.some((item) => item.id === folder) || ['calls', 'contacts'].includes(folder))) {
            setActiveFolder(folder);
        } else if (!folder) {
            setActiveFolder('all');
        }
        if (searchParams.get('view') === 'contacts') {
            setActiveFolder('all');
            setShowNewChat(true);
            setContactSearchTitle(t('chat.newChat'));
            setContactSearchPlaceholder(t('chat.searchUsers'));
            setSearchQuery('');
        }
    }, [searchParams, folderConfig, t]);

    useEffect(() => {
        const syncFolders = () => setFolderConfig(getFolderConfig());
        window.addEventListener('unichat-folders-updated', syncFolders);
        return () => window.removeEventListener('unichat-folders-updated', syncFolders);
    }, []);

    useEffect(() => {
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setMessageMenu(null);
                setForwardingMessage(null);
            }
        };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, []);

    useEffect(() => {
        if (!readOnly) return;
        setShowCreateMenu(false);
        setShowNewChat(false);
        setShowNewGroup(false);
        setShowNewChannel(false);
        setMessageMenu(null);
        setForwardingMessage(null);
        setReplyTo(null);
        setShowContactsMenu(false);
        setShowCallMenu(false);
    }, [readOnly]);

    const openMessageMenuAt = (clientX: number, clientY: number, message: any) => {
        const menuWidth = 280;
        setReadReceipts(null);
        setMessageMenu({
            message,
            x: Math.max(8, Math.min(clientX, window.innerWidth - menuWidth - 8)),
            y: Math.max(8, Math.min(clientY, window.innerHeight - 430)),
        });
    };

    const openMessageMenu = (event: React.MouseEvent, message: any) => {
        event.preventDefault();
        openMessageMenuAt(event.clientX, event.clientY, message);
    };

    const startMessagePress = (event: React.TouchEvent, message: any) => {
        const touch = event.touches[0];
        cancelMessagePress();
        messagePressTimerRef.current = setTimeout(() => openMessageMenuAt(touch.clientX, touch.clientY, message), 550);
    };

    const cancelMessagePress = () => {
        if (messagePressTimerRef.current) clearTimeout(messagePressTimerRef.current);
    };

    const runMessageAction = async (action: string, message: any) => {
        if (action !== 'readers') setMessageMenu(null);
        try {
            if (action === 'reply') setReplyTo(message);
            if (action === 'forward') setForwardingMessage(message);
            if (action === 'copy') await navigator.clipboard.writeText(message.content || message.fileName || message.fileUrl || '');
            if (action === 'copy-link') await navigator.clipboard.writeText(`${window.location.origin}/chat/${message.chatId}?message=${message.id}`);
            if (action === 'unread') await api.markChatUnread(message.chatId);
            if (action === 'select') setSelectedMessageIds((current) => current.includes(message.id) ? current.filter((id) => id !== message.id) : [...current, message.id]);
            if (action === 'edit' && message.senderId === user?.id && message.type === 'TEXT') {
                const content = window.prompt('Изменить сообщение', message.content || '');
                if (content !== null && content.trim()) socketService.editMessage(message.id, content.trim());
            }
            if (action === 'report' && message.senderId !== user?.id) await api.reportUser(message.senderId, 'OTHER', `Жалоба на сообщение ${message.id}`);
            if (action === 'delete' && message.senderId === user?.id && window.confirm('Удалить это сообщение?')) socketService.deleteMessage(message.id);
            if (action === 'pin') {
                const result = await api.toggleMessagePin(message.id);
                setMessagePinned(message.chatId, message.id, result.pinnedAt);
            }
            if (action === 'readers') {
                const readers = await api.getMessageReaders(message.chatId, message.id);
                setReadReceipts(readers.map((reader: any) => ({
                    name: reader.user.displayName || reader.user.username || 'Пользователь',
                    read: true,
                    lastReadAt: reader.lastReadAt,
                    isVerified: reader.user.isVerified,
                })));
            }
        } catch (error) {
            console.error('Message action failed:', error);
        }
    };

    const forwardMessageToChat = (targetChat: any) => {
        if (!forwardingMessage) return;
        const message = forwardingMessage;
        socketService.sendMessage({
            chatId: targetChat.id,
            content: message.content,
            type: message.type,
            fileUrl: message.fileUrl,
            fileName: message.fileName,
            fileSize: message.fileSize,
            mimeType: message.mimeType,
            duration: message.duration,
        }, (result) => {
            if (result?.error) console.error('Message forwarding failed:', result.error);
        });
        setForwardingMessage(null);
    };

    const loadChat = async (id: string) => {
        const sequence = ++chatLoadSequenceRef.current;
        try {
            const chat = await api.getChat(id);
            let cursor: string | undefined;
            let history: any[] = [];
            let hasMore = true;
            while (hasMore) {
                const page = await api.getMessages(id, cursor, 100);
                history = [...page.messages, ...history];
                cursor = page.nextCursor || undefined;
                hasMore = Boolean(cursor);
            }
            if (sequence !== chatLoadSequenceRef.current) return;
            setActiveChat(chat);
            setMessages(id, history);
            socketService.markRead(id);
            updateChatMeta({ id, unreadCount: 0 });
        } catch (err) {
            if (sequence === chatLoadSequenceRef.current) console.error('Failed to load chat:', err);
        }
    };

    const getChatName = (chat: any): string => {
        if (chat.type !== 'PRIVATE') return chat.name || 'Group';
        const other = chat.members?.find((m: any) => m.user.id !== user?.id);
        return other?.user.displayName || other?.user.username || 'Chat';
    };

    const getChatAvatar = (chat: any): string | null => {
        if (chat.type !== 'PRIVATE') return chat.avatarUrl;
        const other = chat.members?.find((m: any) => m.user.id !== user?.id);
        return other?.user.avatarUrl;
    };

    const getOtherUserId = (chat: any): string | null => {
        if (chat.type !== 'PRIVATE') return null;
        return chat.members?.find((m: any) => m.user.id !== user?.id)?.user.id || null;
    };

    const getChatAvatarId = (chat: any): string => {
        if (chat.type !== 'PRIVATE') return chat.id;
        const other = chat.members?.find((m: any) => m.user.id !== user?.id);
        return other?.user.id || chat.id;
    };

    const openContactSearch = (title: string, placeholder: string) => {
        setShowContactsMenu(false);
        setContactSearchTitle(title);
        setContactSearchPlaceholder(placeholder);
        setSearchQuery('');
        setShowNewChat(true);
    };

    const showSidebarAction = (message: string) => {
        setSidebarFeedback(message);
        window.setTimeout(() => setSidebarFeedback(''), 2800);
    };

    const inviteByLink = async () => {
        setShowContactsMenu(false);
        const inviteUrl = `${window.location.origin}/login`;
        try {
            if (navigator.share) await navigator.share({ title: 'UniChat', url: inviteUrl });
            else if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(inviteUrl);
                showSidebarAction('Ссылка скопирована');
            } else window.prompt('Ссылка для приглашения', inviteUrl);
        } catch (error) {
            if (error instanceof Error && error.name !== 'AbortError') showSidebarAction('Не удалось поделиться ссылкой');
        }
    };

    const savePhonebookContacts = async (contacts: PhonebookContact[]) => {
        if (!user?.id) return;
        const uniqueContacts = [...new Map(contacts
            .map((contact) => ({ name: contact.name.trim(), phone: normalizeContactPhone(contact.phone) }))
            .filter((contact) => contact.phone.replace(/\D/g, '').length >= 6)
            .map((contact) => [contact.phone, contact])).values()].slice(0, 500);
        setPhoneContacts(uniqueContacts);
        setPhonebookError('');
        localStorage.setItem(`${PHONEBOOK_STORAGE_PREFIX}${user.id}`, JSON.stringify(uniqueContacts));
        if (!uniqueContacts.length) {
            setMatchedPhoneContacts({});
            setPhonebookError('В выбранных контактах не найдены номера телефонов.');
            return;
        }

        setPhonebookLoading(true);
        try {
            const accounts: PhonebookAccount[] = await api.lookupPhoneContacts(uniqueContacts.map((contact) => contact.phone));
            setMatchedPhoneContacts(Object.fromEntries(accounts.map((account) => [normalizeContactPhone(account.phone), account])));
        } catch {
            setPhonebookError('Не удалось сопоставить номера с аккаунтами UniChat.');
        } finally {
            setPhonebookLoading(false);
        }
    };

    const requestPhonebookAccess = async () => {
        setPhonebookError('');
        const picker = (navigator as ContactPickerNavigator).contacts;
        if (!picker) {
            phonebookFileInputRef.current?.click();
            return;
        }

        setPhonebookLoading(true);
        try {
            const selected = await picker.select(['name', 'tel'], { multiple: true });
            const imported = selected.flatMap((contact) => {
                const name = contact.name?.find((value) => value.trim())?.trim() || '';
                return (contact.tel || []).map((phone) => ({ name, phone }));
            });
            await savePhonebookContacts(imported);
        } catch (error) {
            if (!(error instanceof Error && error.name === 'AbortError')) setPhonebookError('Не удалось получить контакты телефона.');
        } finally {
            setPhonebookLoading(false);
        }
    };

    const importVCard = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const input = event.currentTarget;
        const file = input.files?.[0];
        if (!file) return;
        setPhonebookLoading(true);
        setPhonebookError('');
        try {
            const imported = parseVCard(await file.text());
            if (!imported.length) setPhonebookError('В файле не найдены контакты с номерами телефонов.');
            else await savePhonebookContacts(imported);
        } catch {
            setPhonebookError('Не удалось прочитать файл контактов.');
        } finally {
            setPhonebookLoading(false);
            input.value = '';
        }
    };

    const openPhonebookContact = async (contact: PhonebookContact) => {
        const account = matchedPhoneContacts[normalizeContactPhone(contact.phone)];
        if (!account) {
            showSidebarAction('Этого контакта пока нет в UniChat');
            return;
        }
        const existingChat = chats.find((chat) => chat.type === 'PRIVATE' && chat.members.some((member: any) => member.userId === account.id));
        if (existingChat) navigate(`/chat/${existingChat.id}`);
        else await handleCreatePrivateChat(account.id);
    };

    // ── Folder filtering ──
    const isChatUnread = (chat: any) => {
        if (typeof chat.unreadCount === 'number') return chat.unreadCount > 0;
        const lastMessage = chat.messages?.[0];
        const membership = chat.members?.find((member: any) => member.userId === user?.id);
        return Boolean(lastMessage && lastMessage.sender?.id !== user?.id && (!membership?.lastReadAt || new Date(lastMessage.createdAt) > new Date(membership.lastReadAt)));
    };

    const filteredChats = chats.filter((chat) => {
        if (activeFolder === 'all') return true;
        if (activeFolder === 'contacts') return chat.type === 'PRIVATE';
        if (activeFolder === 'calls') return false;
        if (activeFolder === 'new') return isChatUnread(chat);
        if (activeFolder === 'channels') return chat.type === 'CHANNEL';
        const customFolder = folderConfig.find((item) => item.id === activeFolder);
        if (customFolder && activeFolder !== 'all' && activeFolder !== 'new' && activeFolder !== 'channels') {
            const filters = customFolder.filters;
            const membership = chat.members?.find((member: any) => member.userId === user?.id);
            const isUnread = isChatUnread(chat);
            const matchesCategory = !filters?.categories.length || filters.categories.some((category) => {
                if (category === 'contacts' || category === 'nonContacts') return chat.type === 'PRIVATE';
                if (category === 'groups') return chat.type === 'GROUP';
                if (category === 'channels') return chat.type === 'CHANNEL';
                return false;
            });
            const hasSound = !membership?.mutedUntil || new Date(membership.mutedUntil) <= new Date();
            return matchesCategory && (!filters?.soundOnly || hasSound) && (!filters?.unreadOnly || isUnread);
        }
        return false;
    });
    const visibleChats = filteredChats.filter((chat) => {
        const query = listSearch.trim().toLowerCase();
        if (!query) return true;
        const otherUser = chat.members?.find((member: any) => member.userId !== user?.id)?.user;
        return `${getChatName(chat)} ${otherUser?.username || ''} ${chat.messages?.[0]?.content || ''}`.toLowerCase().includes(query);
    });
    const visiblePhoneContacts = phoneContacts.filter((contact) => {
        const query = listSearch.trim().toLowerCase();
        return !query || `${contact.name} ${contact.phone}`.toLowerCase().includes(query);
    });

    // ── Send message ──
    const handleSendMessage = async () => {
        if (readOnly || !messageText.trim() || !chatId) return;
        const data: any = { chatId, content: messageText.trim(), type: 'TEXT' };
        if (replyTo) data.replyToId = replyTo.id;
        socketService.sendMessage(data, (result) => {
            if (!result?.error) scrollToLatest();
        });
        setMessageText('');
        setReplyTo(null);
        socketService.stopTyping(chatId);
    };

    const handleTyping = () => {
        if (readOnly || !chatId) return;
        socketService.startTyping(chatId);
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => socketService.stopTyping(chatId), 2000);
    };

    // ── File upload ──
    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (readOnly || !file || !chatId) return;
        try {
            const result = await api.uploadFile(file);
            const isImage = file.type.startsWith('image/');
            socketService.sendMessage({
                chatId,
                type: isImage ? 'IMAGE' : 'FILE',
                fileUrl: result.url,
                fileName: result.fileName,
                fileSize: file.size,
                mimeType: result.mimeType,
                content: isImage ? '📷 Фото' : `📎 ${result.fileName}`,
            });
        } catch (err) {
            console.error('Upload failed:', err);
        }
        e.target.value = '';
    };

    // ── Voice recording ──
    const recordingTimeRef = useRef(0);
    const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
    const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');

    useEffect(() => {
        const getDevices = async () => {
            try {
                // Request permission first to get labels
                await navigator.mediaDevices.getUserMedia({ audio: true });
                const devices = await navigator.mediaDevices.enumerateDevices();
                const audioInputs = devices.filter(d => d.kind === 'audioinput');
                setAudioDevices(audioInputs);
                if (audioInputs.length > 0 && !selectedDeviceId) {
                    setSelectedDeviceId(audioInputs[0].deviceId);
                }
            } catch (err) {
                console.error('Error enumerating devices:', err);
            }
        };
        getDevices();
    }, []);

    const startRecording = async () => {
        if (readOnly) return;
        try {
            const constraints: MediaStreamConstraints = {
                audio: {
                    deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                }
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            const audioTrack = stream.getAudioTracks()[0];
            console.log('🎙️ Got mic stream, tracks:', stream.getAudioTracks().length);
            console.log('🎙️ Mic device:', audioTrack?.label || 'unknown');
            console.log('🎙️ Mic settings:', JSON.stringify(audioTrack?.getSettings()));

            // ── Web Audio API: monitor mic level ──
            const audioCtx = new AudioContext();
            const source = audioCtx.createMediaStreamSource(stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 2048;
            source.connect(analyser);
            const dataArray = new Uint8Array(analyser.frequencyBinCount);

            // Monitor mic levels periodically
            const levelInterval = setInterval(() => {
                analyser.getByteTimeDomainData(dataArray);
                let maxAmplitude = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    const amplitude = Math.abs(dataArray[i] - 128);
                    if (amplitude > maxAmplitude) maxAmplitude = amplitude;
                }
                const level = Math.round((maxAmplitude / 128) * 100);
                console.log(`🎙️ Mic level: ${level}% (max amplitude: ${maxAmplitude}/128) ${level > 5 ? '🔊 SOUND DETECTED' : '🔇 SILENCE'}`);
            }, 1000);

            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : MediaRecorder.isTypeSupported('audio/webm')
                    ? 'audio/webm'
                    : '';
            console.log('🎙️ Using mimeType:', mimeType || '(browser default)');

            const recorder = mimeType
                ? new MediaRecorder(stream, { mimeType })
                : new MediaRecorder(stream);

            mediaRecorderRef.current = recorder;
            audioChunksRef.current = [];
            recordingTimeRef.current = 0;

            recorder.ondataavailable = (e) => {
                console.log('🎙️ Data chunk:', e.data.size, 'bytes');
                if (e.data.size > 0) audioChunksRef.current.push(e.data);
            };

            recorder.onstop = async () => {
                // Stop mic level monitoring
                clearInterval(levelInterval);
                source.disconnect();
                audioCtx.close();

                const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
                console.log('🎙️ Recording complete. Blob size:', blob.size, 'type:', blob.type, 'chunks:', audioChunksRef.current.length);

                // ── Analyze recorded audio for actual content ──
                try {
                    const arrayBuffer = await blob.arrayBuffer();
                    const decodeCtx = new AudioContext();
                    const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
                    const channelData = audioBuffer.getChannelData(0);
                    let maxSample = 0;
                    let rms = 0;
                    for (let i = 0; i < channelData.length; i++) {
                        const abs = Math.abs(channelData[i]);
                        if (abs > maxSample) maxSample = abs;
                        rms += channelData[i] * channelData[i];
                    }
                    rms = Math.sqrt(rms / channelData.length);
                    console.log(`🎙️ Audio analysis: duration=${audioBuffer.duration.toFixed(2)}s, maxSample=${maxSample.toFixed(4)}, RMS=${rms.toFixed(6)}, sampleRate=${audioBuffer.sampleRate}`);
                    if (maxSample < 0.01) {
                        console.error('🎙️ ❌ RECORDING IS SILENT! Max sample is near zero. Check your microphone!');
                    } else {
                        console.log('🎙️ ✅ Recording contains audio data!');
                    }
                    decodeCtx.close();
                } catch (analyzeErr) {
                    console.error('🎙️ Audio analysis failed:', analyzeErr);
                }

                const file = new File([blob], `voice_${Date.now()}.webm`, { type: recorder.mimeType });
                try {
                    const result = await api.uploadFile(file);
                    console.log('🎙️ Uploaded. URL:', result.url, 'mimeType:', result.mimeType);
                    if (chatId) {
                        socketService.sendMessage({
                            chatId,
                            type: 'VOICE',
                            fileUrl: result.url,
                            fileName: result.fileName,
                            mimeType: result.mimeType || recorder.mimeType,
                            content: '🎤 Голосовое сообщение',
                            duration: recordingTimeRef.current,
                        });
                    }
                } catch (err) {
                    console.error('🎙️ Voice upload failed:', err);
                }
                stream.getTracks().forEach((t) => t.stop());
                setRecordingTime(0);
                recordingTimeRef.current = 0;
            };

            recorder.start(1000); // collect data every 1s for larger chunks
            setIsRecording(true);

            // Recording timer
            let sec = 0;
            recordingTimerRef.current = setInterval(() => {
                sec++;
                recordingTimeRef.current = sec;
                setRecordingTime(sec);
            }, 1000);
        } catch (err) {
            console.error('🎙️ Mic access denied:', err);
        }
    };

    const stopRecording = () => {
        mediaRecorderRef.current?.stop();
        setIsRecording(false);
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };

    const cancelRecording = () => {
        if (mediaRecorderRef.current) {
            mediaRecorderRef.current.ondataavailable = null;
            mediaRecorderRef.current.onstop = null;
            mediaRecorderRef.current.stream?.getTracks().forEach((t) => t.stop());
            try { mediaRecorderRef.current.stop(); } catch { }
        }
        setIsRecording(false);
        setRecordingTime(0);
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };

    // ── Search users ──
    useEffect(() => {
        if (searchQuery.length < 2) { setSearchResults([]); return; }
        const timer = setTimeout(async () => {
            try { setSearchResults(await api.searchUsers(searchQuery)); } catch { }
        }, 300);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    const handleCreatePrivateChat = async (userId: string) => {
        if (readOnly) return;
        try {
            const chat = await api.createPrivateChat(userId);
            setShowNewChat(false);
            setSearchQuery('');
            socketService.joinChat(chat.id);
            setChats(await api.getChats());
            navigate(`/chat/${chat.id}`);
        } catch { }
    };

    const handleCreateGroup = async () => {
        if (readOnly || !groupName.trim()) return;
        try {
            const chat = await api.createGroupChat(groupName, selectedMembers);
            setShowNewGroup(false);
            setGroupName('');
            setSelectedMembers([]);
            socketService.joinChat(chat.id);
            setChats(await api.getChats());
            navigate(`/chat/${chat.id}`);
        } catch { }
    };

    const handleCreateChannel = async () => {
        if (readOnly || !groupName.trim()) return;
        try {
            const chat = await api.createChannel(groupName, selectedMembers);
            setShowNewChannel(false);
            setGroupName('');
            setSelectedMembers([]);
            socketService.joinChat(chat.id);
            setChats(await api.getChats());
            navigate(`/chat/${chat.id}`);
        } catch (error) {
            console.error('Channel creation failed:', error);
        }
    };

    const handleProfileUpdate = (data: any) => {
        updateUser(data);
    };

    const chatMessages = messages[chatId || ''] || [];
    const chatTyping = typingUsers[chatId || ''] || [];
    const sidebarTitle = (() => {
        if (activeFolder === 'all') return 'Все';
        if (activeFolder === 'new') return 'Новые';
        if (activeFolder === 'channels') return 'Каналы';
        if (activeFolder === 'calls') return 'Звонки';
        if (activeFolder === 'contacts') return 'Контакты';
        return folderConfig.find((item) => item.id === activeFolder)?.label || 'UniChat';
    })();
    let lastDate = '';

    useEffect(() => {
        if (!user?.id) return;
        let active = true;
        setMatchedPhoneContacts({});
        setPhonebookError('');
        try {
            const stored: unknown = JSON.parse(localStorage.getItem(`${PHONEBOOK_STORAGE_PREFIX}${user.id}`) || '[]');
            const saved = Array.isArray(stored) ? stored
                .filter((entry) => entry && typeof entry === 'object')
                .map((entry: any) => ({ name: String(entry.name || ''), phone: normalizeContactPhone(String(entry.phone || '')) }))
                .filter((entry: PhonebookContact) => entry.phone.replace(/\D/g, '').length >= 6) as PhonebookContact[] : [];
            setPhoneContacts(saved);
            if (saved.length) {
                setPhonebookLoading(true);
                api.lookupPhoneContacts(saved.map((contact) => contact.phone))
                    .then((accounts: PhonebookAccount[]) => {
                        if (active) setMatchedPhoneContacts(Object.fromEntries(accounts.map((account) => [normalizeContactPhone(account.phone), account])));
                    })
                    .catch(() => { if (active) setPhonebookError('Не удалось сопоставить номера с аккаунтами UniChat.'); })
                    .finally(() => { if (active) setPhonebookLoading(false); });
            }
        } catch {
            setPhoneContacts([]);
        }
        return () => { active = false; };
    }, [user?.id]);
    const supportsPhoneContactPicker = Boolean((navigator as ContactPickerNavigator).contacts?.select);

    return (
        <div className={`app-layout ${chatId ? 'chat-open' : ''}`}>
            {incomingNotice && <button className="incoming-notice" onClick={() => { navigate(`/chat/${incomingNotice.chatId}`); setIncomingNotice(null); }}>
                <strong>{incomingNotice.title}</strong><span>{incomingNotice.body}</span>
            </button>}
            {messageMenu && <div className="message-context-layer" onClick={() => { setMessageMenu(null); setReadReceipts(null); }}>
                <div className="message-context-menu" style={{ left: messageMenu.x, top: messageMenu.y }} onClick={(event) => event.stopPropagation()}>
                    {!readOnly && <div className="message-reaction-picker">
                        {['👍', '❤️', '😂', '🔥', '😢', '😍', '👌'].map((emoji) => <button key={emoji} title={emoji} onClick={() => { socketService.reactToMessage(messageMenu.message.id, emoji); setMessageMenu(null); }}>{emoji}</button>)}
                    </div>}
                    {!readOnly && activeChat?.type !== 'CHANNEL' && <button className="message-context-item" onClick={() => runMessageAction('reply', messageMenu.message)}>↩ <span>Ответить</span></button>}
                    {!readOnly && <button className="message-context-item" onClick={() => runMessageAction('forward', messageMenu.message)}>➦ <span>Переслать</span></button>}
                    {activeChat?.type !== 'PRIVATE' && <button className="message-context-item" onClick={() => runMessageAction('copy-link', messageMenu.message)}>🔗 <span>Копировать ссылку на сообщение</span></button>}
                    {!readOnly && activeChat?.type === 'GROUP' && activeChat.members?.some((member: any) => member.userId === user?.id && ['OWNER', 'ADMIN'].includes(member.role)) && (
                        <button className="message-context-item" onClick={() => runMessageAction('pin', messageMenu.message)}>📌 <span>{messageMenu.message.pinnedAt ? 'Открепить' : 'Закрепить'}</span></button>
                    )}
                    {!readOnly && <button className="message-context-item" onClick={() => runMessageAction('unread', messageMenu.message)}>▣ <span>Отметить непрочитанным</span></button>}
                    {activeChat?.type !== 'PRIVATE' && <button className="message-context-item" onClick={() => runMessageAction('readers', messageMenu.message)}>◉ <span>Кто прочитал</span><span className="message-context-chevron">›</span></button>}
                    {readReceipts && <div className="message-readers-list">{readReceipts.length ? readReceipts.map((reader, index) => <div key={`${reader.name}-${index}`}><span>{reader.name}{reader.isVerified && <VerifiedBadge />}</span><small>Прочитано {reader.lastReadAt ? formatTime(reader.lastReadAt) : ''}</small></div>) : <small>Пока никто не прочитал</small>}</div>}
                    <button className="message-context-item" onClick={() => runMessageAction('copy', messageMenu.message)}>▢ <span>Копировать текст</span></button>
                    <button className="message-context-item" onClick={() => runMessageAction('select', messageMenu.message)}>⊙ <span>{selectedMessageIds.includes(messageMenu.message.id) ? 'Снять выделение' : 'Выбрать'}</span></button>
                    {!readOnly && messageMenu.message.senderId === user?.id && messageMenu.message.type === 'TEXT' && <button className="message-context-item" onClick={() => runMessageAction('edit', messageMenu.message)}>✎ <span>Изменить</span></button>}
                    {!readOnly && messageMenu.message.senderId !== user?.id && <button className="message-context-item danger" onClick={() => runMessageAction('report', messageMenu.message)}>⚠ <span>Пожаловаться</span></button>}
                    {!readOnly && messageMenu.message.senderId === user?.id && activeChat?.type !== 'CHANNEL' && <button className="message-context-item danger" onClick={() => runMessageAction('delete', messageMenu.message)}>⌫ <span>Удалить</span></button>}
                </div>
            </div>}
            {forwardingMessage && <div className="modal-overlay" onClick={() => setForwardingMessage(null)}>
                <div className="modal message-forward-modal" onClick={(event) => event.stopPropagation()}>
                    <div className="profile-modal-header"><h3>Переслать сообщение</h3><button className="btn-icon" onClick={() => setForwardingMessage(null)}>×</button></div>
                    {chats.filter((chat) => chat.id !== forwardingMessage.chatId).map((chat) => <button className="message-forward-target" key={chat.id} onClick={() => forwardMessageToChat(chat)}>{getChatName(chat)}</button>)}
                </div>
            </div>}
            <nav className="nav-rail" aria-label="Навигация">
                {folderConfig.map((item) => (
                    <button
                        key={item.id}
                        className={`nav-rail-button ${activeFolder === item.id ? 'active' : ''}`}
                        onClick={() => {
                            setActiveFolder(item.id);
                            navigate(`/chat?folder=${encodeURIComponent(item.id)}`);
                        }}
                        title={item.label}
                    >
                        <span>{item.icon}</span><small>{item.label}</small>
                    </button>
                ))}
                <div className="nav-rail-divider" />
                <button className={`nav-rail-button ${activeFolder === 'contacts' ? 'active' : ''}`} onClick={() => { setActiveFolder('contacts'); setListSearch(''); setShowNewChat(false); navigate('/chat?folder=contacts'); }} title="Контакты">
                    <span>👤</span><small>Контакты</small>
                </button>
                <button className={`nav-rail-button ${activeFolder === 'calls' ? 'active' : ''}`} onClick={() => { setActiveFolder('calls'); navigate('/chat?folder=calls'); }} title="Звонки">
                    <span>📞</span><small>Звонки</small>
                </button>
                <div className="nav-rail-spacer" />
                <button className="nav-rail-button" onClick={() => navigate('/settings/profile')} title={t('settings.title')}>
                    <span>⚙️</span><small>Настройки</small>
                </button>
            </nav>
            {/* ═══ SIDEBAR ═══ */}
            <div className="sidebar">
                <div className="sidebar-header">
                    <div className="sidebar-logo">
                        <h1>{sidebarTitle}</h1>
                    </div>
                    <div className="sidebar-actions">
                        {activeFolder === 'calls' ? (
                            <button className="btn-icon call-menu-trigger" onClick={() => setShowCallMenu((open) => !open)} title="Меню звонков">⋮</button>
                        ) : (
                            <button className="btn-icon" onClick={() => activeFolder === 'contacts' ? setShowContactsMenu((open) => !open) : setShowCreateMenu((open) => !open)} title={activeFolder === 'contacts' ? 'Действия с контактами' : 'Создать'} disabled={readOnly && activeFolder !== 'contacts'}>✏️</button>
                        )}
                    </div>
                    {activeFolder === 'contacts' && showContactsMenu && <div className="create-menu sidebar-action-menu">
                        <button disabled={readOnly} onClick={() => openContactSearch('Добавить контакт', 'Найти пользователя')}>＋ Добавить контакт</button>
                        <button onClick={() => { setShowContactsMenu(false); setActiveFolder('calls'); setCallTab('all'); navigate('/chat?folder=calls'); }}>☎ Создать групповой звонок</button>
                        <button onClick={() => openContactSearch('Найти по номеру', 'Введите номер телефона')}>⌕ Найти по номеру</button>
                        <button onClick={inviteByLink}>↗ Пригласить по ссылке</button>
                    </div>}
                    {activeFolder === 'calls' && showCallMenu && <div className="create-menu sidebar-action-menu">
                        <button onClick={() => { setShowCallMenu(false); setCallSelectionMode((mode) => !mode); showSidebarAction('Звонков пока нет'); }}>{callSelectionMode ? '✓ Отменить выбор' : '☑ Выбрать'}</button>
                        <button onClick={() => { setShowCallMenu(false); showSidebarAction('История звонков пуста'); }}>♧ Очистить историю звонков</button>
                    </div>}
                    {activeFolder !== 'contacts' && activeFolder !== 'calls' && showCreateMenu && !readOnly && <div className="create-menu">
                        <button onClick={() => { setShowCreateMenu(false); openContactSearch(t('chat.newChat'), t('chat.searchUsers')); }}>💬 Создать чат</button>
                        <button onClick={() => { setShowCreateMenu(false); setShowNewGroup(true); setSearchQuery(''); setSelectedMembers([]); setGroupName(''); }}>👥 Создать группу</button>
                        <button onClick={() => { setShowCreateMenu(false); setShowNewChannel(true); setSearchQuery(''); setSelectedMembers([]); setGroupName(''); }}>📢 Создать канал</button>
                    </div>}
                </div>

                {activeFolder === 'calls' && <>
                    <button className="group-call-action" onClick={() => showSidebarAction('Групповые звонки пока недоступны')}><span>↗</span> Создать групповой звонок</button>
                    <div className="call-tabs" role="tablist" aria-label="Фильтр звонков">
                        <button role="tab" aria-selected={callTab === 'all'} className={callTab === 'all' ? 'active' : ''} onClick={() => setCallTab('all')}>Все</button>
                        <button role="tab" aria-selected={callTab === 'missed'} className={callTab === 'missed' ? 'active' : ''} onClick={() => setCallTab('missed')}>Пропущенные</button>
                    </div>
                </>}
                {activeFolder !== 'calls' && <div className="sidebar-search">
                    <div className="search-wrapper">
                        <span className="search-icon">🔍</span>
                        <input className="input" value={listSearch} onChange={(event) => setListSearch(event.target.value)} placeholder={activeFolder === 'contacts' ? 'Найти' : `${t('common.search')}...`} />
                    </div>
                </div>}
                {activeFolder === 'contacts' && <input ref={phonebookFileInputRef} className="phonebook-file-input" type="file" accept=".vcf,text/vcard" onChange={importVCard} />}
                {activeFolder === 'contacts' && phoneContacts.length > 0 && <button className="phonebook-refresh" disabled={phonebookLoading} onClick={requestPhonebookAccess}>
                    {phonebookLoading ? 'Сопоставление контактов...' : supportsPhoneContactPicker ? 'Обновить телефонную книгу' : 'Импортировать ещё контакты (.vcf)'}
                </button>}
                {sidebarFeedback && <div className="sidebar-feedback" role="status">{sidebarFeedback}</div>}

                <div className="chat-list">
                    {activeFolder === 'contacts' && phoneContacts.length === 0 && <section className="phonebook-permission">
                        <div className="phonebook-icon">♙</div>
                        <strong>Контакты из телефона</strong>
                        <p>{supportsPhoneContactPicker ? 'Нажмите «Разрешить» и выберите контакты в системном окне устройства.' : 'Этот браузер не поддерживает прямой доступ к телефонной книге. Выберите экспортированный файл контактов .vcf.'}</p>
                        <button className="btn btn-primary" disabled={phonebookLoading} onClick={requestPhonebookAccess}>{phonebookLoading ? 'Загрузка...' : supportsPhoneContactPicker ? 'Разрешить' : 'Выбрать файл контактов'}</button>
                        {supportsPhoneContactPicker && <button className="phonebook-import-link" disabled={phonebookLoading} onClick={() => phonebookFileInputRef.current?.click()}>Импортировать файл контактов (.vcf)</button>}
                        {phonebookError && <small className="phonebook-error" role="alert">{phonebookError}</small>}
                    </section>}
                    {activeFolder === 'contacts' && phoneContacts.length > 0 && visiblePhoneContacts.length === 0 && <div className="phonebook-no-results">Контакты не найдены</div>}
                    {activeFolder !== 'contacts' && visibleChats.length === 0 && (
                        <div className={`empty-state ${activeFolder === 'calls' ? 'calls-empty-state' : ''}`}>
                            {activeFolder !== 'calls' && <div className="empty-state-icon">{activeFolder === 'contacts' ? '👤' : '💬'}</div>}
                            <div className="empty-state-title">{activeFolder === 'calls' ? (callTab === 'missed' ? 'Пропущенных звонков пока нет' : t('chat.noCalls')) : activeFolder === 'channels' ? t('chat.noChannels').split('.')[0] : t('chat.noChats').split('.')[0]}</div>
                            {activeFolder !== 'calls' && <div className="empty-state-subtitle">{activeFolder === 'channels' ? t('chat.noChannels').split('.').slice(1).join('.').trim() : t('chat.noChats').split('.').slice(1).join('.').trim()}</div>}
                        </div>
                    )}
                    {activeFolder === 'contacts' && visiblePhoneContacts.map((contact) => {
                        const account = matchedPhoneContacts[normalizeContactPhone(contact.phone)];
                        const isOnline = account ? onlineUsers.has(account.id) : false;
                        return (
                            <button className="contact-list-item" key={contact.phone} onClick={() => account ? void openPhonebookContact(contact) : void inviteByLink()}>
                                <span className={`avatar ${getAvatarClass(account?.id || contact.phone)} ${isOnline ? 'avatar-online' : ''}`}>
                                    {account?.avatarUrl ? <img src={account.avatarUrl} alt="" /> : getInitials(contact.name)}
                                </span>
                                <span className="contact-list-info">
                                    <strong>{contact.name}{account?.isVerified && <VerifiedBadge />}</strong>
                                    <small>{phonebookLoading ? 'Сопоставление...' : account ? (isOnline ? 'в сети' : 'В UniChat') : 'Пригласить в UniChat'}</small>
                                </span>
                            </button>
                        );
                    })}
                    {activeFolder === 'contacts' && phonebookError && phoneContacts.length > 0 && <div className="phonebook-error phonebook-error-list" role="alert">{phonebookError}</div>}
                    {activeFolder !== 'contacts' && visibleChats.map((chat) => {
                        const name = getChatName(chat);
                        const lastMsg = chat.messages?.[0];
                        const otherUserId = getOtherUserId(chat);
                        const otherMember = chat.members?.find((member: any) => member.userId === otherUserId);
                        const isOnline = otherUserId ? onlineUsers.has(otherUserId) : false;
                        const avatarId = getChatAvatarId(chat);

                        return (
                            <div key={chat.id} className={`chat-item ${chat.id === chatId ? 'active' : ''}`} onClick={() => navigate(`/chat/${chat.id}`)}>
                                <div className={`avatar ${getAvatarClass(avatarId)} ${isOnline ? 'avatar-online' : ''}`}>
                                    {getChatAvatar(chat) ? <img src={getChatAvatar(chat)!} alt="" /> : getInitials(name)}
                                </div>
                                <div className="chat-item-content">
                                    <div className="chat-item-header">
                                        <span className="chat-item-name">
                                            {name}{isChatIdentityVerified(chat, user?.id) && <VerifiedBadge label={chat.type === 'CHANNEL' ? 'Верифицированный канал' : 'Верифицированный аккаунт'} />}
                                        </span>
                                        {lastMsg && <span className="chat-item-time">{formatTime(lastMsg.createdAt)}</span>}
                                    </div>
                                    <div className="chat-item-preview">{lastMsg?.content || '...'}</div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* ═══ CHAT AREA ═══ */}
            <div className="chat-area">
                {!chatId || !activeChat ? (
                    <div className="empty-state">
                        <div className="empty-state-icon">💬</div>
                        <div className="empty-state-title">{activeFolder === 'calls' ? t('chat.noCalls') : activeFolder === 'channels' ? t('chat.noChannels').split('.')[0] : 'UniChat'}</div>
                        {activeFolder !== 'calls' && <div className="empty-state-subtitle">{activeFolder === 'channels' ? t('chat.noChannels') : t('chat.noChats')}</div>}
                    </div>
                ) : (
                    <>
                        {/* Header */}
                        <div className="chat-header">
                            <button className="btn-icon chat-header-back" onClick={() => navigate('/chat')}>←</button>
                            <div className={`avatar ${getAvatarClass(getChatAvatarId(activeChat))} ${(() => { const uid = getOtherUserId(activeChat); return uid && onlineUsers.has(uid) ? 'avatar-online' : ''; })()}`}>
                                {getChatAvatar(activeChat) ? <img src={getChatAvatar(activeChat)!} alt="" /> : getInitials(getChatName(activeChat))}
                            </div>
                            <div className="chat-header-info">
                                <div className="chat-header-name">{getChatName(activeChat)}{isChatIdentityVerified(activeChat, user?.id) && <VerifiedBadge label={activeChat.type === 'CHANNEL' ? 'Верифицированный канал' : 'Верифицированный аккаунт'} />}</div>
                                <div className={`chat-header-status ${(() => { const uid = getOtherUserId(activeChat); return uid && onlineUsers.has(uid) ? 'online' : ''; })()}`}>
                                    {activeChat.type !== 'PRIVATE'
                                        ? `${activeChat.members.length} ${t(activeChat.type === 'CHANNEL' ? 'chat.subscribers' : 'chat.members')}`
                                        : (() => {
                                            const uid = getOtherUserId(activeChat);
                                            if (uid && onlineUsers.has(uid)) return t('chat.online');
                                            const member = activeChat.members.find((item: any) => item.userId === uid);
                                            return formatLastSeen((uid && lastSeenByUser[uid]) || member?.user?.lastSeenAt);
                                        })()}
                                </div>
                            </div>
                            <div className="chat-header-actions">
                                <button className="btn-icon" title="Search">🔍</button>
                                <button className="btn-icon" title="More">⋯</button>
                            </div>
                        </div>

                        {/* Messages */}
                        <div className="messages-container" ref={messagesContainerRef}>
                            {chatMessages.length === 0 && (
                                <div className="empty-state">
                                    <div className="empty-state-icon">👋</div>
                                    <div className="empty-state-title">{t('chat.noMessages').split('.')[0]}</div>
                                    <div className="empty-state-subtitle">{t('chat.noMessages').split('.').slice(1).join('.').trim()}</div>
                                </div>
                            )}
                            {chatMessages.map((msg) => {
                                const msgDate = formatDate(msg.createdAt);
                                let showDateSep = false;
                                if (msgDate !== lastDate) { lastDate = msgDate; showDateSep = true; }
                                const isOwn = msg.senderId === user?.id;
                                const isDeleted = !!msg.deletedAt;
                                const isRead = isOwn && activeChat.members.some((member: any) => {
                                    if (member.userId === user?.id) return false;
                                    const readAt = readAtByMember[`${activeChat.id}:${member.userId}`] || member.lastReadAt;
                                    return Boolean(readAt && new Date(readAt).getTime() >= new Date(msg.createdAt).getTime());
                                });

                                return (
                                    <div key={msg.id}>
                                        {showDateSep && <div className="date-separator"><span>{msgDate}</span></div>}
                                        <div
                                            className={`message-wrapper ${isOwn ? 'own' : ''} ${selectedMessageIds.includes(msg.id) ? 'selected' : ''}`}
                                            onContextMenu={(event) => openMessageMenu(event, msg)}
                                            onTouchStart={(event) => startMessagePress(event, msg)}
                                            onTouchMove={cancelMessagePress}
                                            onTouchEnd={cancelMessagePress}
                                        >
                                            <div className="message">
                                                {!isOwn && activeChat.type !== 'PRIVATE' && (
                                                    <div className="message-sender">{msg.sender?.displayName || msg.sender?.username || 'User'}{msg.sender?.isVerified && <VerifiedBadge />}</div>
                                                )}

                                                {msg.replyTo && (
                                                    <div className="message-reply">
                                                        <div className="message-reply-name">{msg.replyTo.sender?.displayName || 'User'}{msg.replyTo.sender?.isVerified && <VerifiedBadge />}</div>
                                                        <div className="message-reply-content">{msg.replyTo.content}</div>
                                                    </div>
                                                )}

                                                {isDeleted ? (
                                                    <div className="message-deleted">🚫 {t('chat.deleted')}</div>
                                                ) : (
                                                    <>
                                                        {msg.type === 'IMAGE' && msg.fileUrl && (
                                                            <img className="message-image" src={msg.fileUrl} alt="" loading="lazy" />
                                                        )}

                                                        {msg.type === 'FILE' && msg.fileUrl && (
                                                            <a className="message-file" href={msg.fileUrl} target="_blank" rel="noopener">
                                                                <div className="message-file-icon">📄</div>
                                                                <div className="message-file-info">
                                                                    <div className="message-file-name">{msg.fileName}</div>
                                                                    <div className="message-file-size">{formatFileSize(msg.fileSize)}</div>
                                                                </div>
                                                            </a>
                                                        )}

                                                        {msg.type === 'VOICE' && msg.fileUrl && (
                                                            <VoicePlayer src={msg.fileUrl} />
                                                        )}

                                                        {msg.type === 'TEXT' && <div className="message-content">{msg.content}</div>}
                                                    </>
                                                )}

                                                <div className="message-meta">
                                                    {msg.editedAt && <span className="message-edited">{t('chat.edited')}</span>}
                                                    <span className="message-time">{formatTime(msg.createdAt)}</span>
                                                    {isOwn && <svg className={`message-read-status ${isRead ? 'read' : ''}`} viewBox={isRead ? '0 0 20 12' : '0 0 14 12'} role="img" aria-label={isRead ? 'Прочитано' : 'Не прочитано'}>
                                                        {isRead ? <path d="M1 6.2 4.7 9.8 12.8 1.8M7 6.2l3.7 3.6 8.1-8" /> : <path d="M1 6.2 4.7 9.8 12.8 1.8" />}
                                                    </svg>}
                                                </div>
                                                {msg.reactions && msg.reactions.length > 0 && <div className="message-reaction-list">{Object.entries(msg.reactions.reduce((groups: Record<string, number>, reaction) => ({ ...groups, [reaction.emoji]: (groups[reaction.emoji] || 0) + 1 }), {})).map(([emoji, count]) => <button key={emoji} onClick={() => socketService.reactToMessage(msg.id, emoji)}>{emoji} {String(count)}</button>)}</div>}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Typing indicator */}
                        <div className="typing-indicator">
                            {chatTyping.length > 0 && (
                                <>
                                    <div className="typing-dots">
                                        <div className="typing-dot" />
                                        <div className="typing-dot" />
                                        <div className="typing-dot" />
                                    </div>
                                    <span>{t('chat.typing')}</span>
                                </>
                            )}
                        </div>

                        {/* Input area */}
                        {readOnly ? <div className="read-only-chat-notice" role="status">
                            <strong>Режим чтения включён</strong>
                            <span>Отправка сообщений временно отключена</span>
                        </div> : <div className="message-input-area">
                            {replyTo && (
                                <div className="reply-bar">
                                    <div className="reply-bar-content">
                                        <div className="reply-bar-name">{replyTo.sender?.displayName || 'User'}</div>
                                        <div className="reply-bar-text">{replyTo.content}</div>
                                    </div>
                                    <button className="btn-icon" onClick={() => setReplyTo(null)} style={{ width: 28, height: 28, fontSize: 14 }}>✕</button>
                                </div>
                            )}

                            {isRecording ? (
                                <div className="recording-bar">
                                    <div className="recording-indicator">
                                        <div className="recording-dot" />
                                        <span className="recording-time">{formatDuration(recordingTime)}</span>
                                    </div>
                                    <div className="recording-wave">
                                        {Array.from({ length: 20 }, (_, i) => (
                                            <div
                                                key={i}
                                                className="recording-wave-bar"
                                                style={{
                                                    animationDelay: `${i * 0.05}s`,
                                                    height: `${8 + Math.random() * 20}px`,
                                                }}
                                            />
                                        ))}
                                    </div>
                                    <button className="btn-icon recording-cancel" onClick={cancelRecording} title="Отмена">✕</button>
                                    <button className="btn-icon recording-stop" onClick={stopRecording} title="Отправить" disabled={readOnly}>➤</button>
                                </div>
                            ) : (
                                <div className="message-input-row">
                                    <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileUpload} />
                                    <button className="btn-icon" onClick={() => fileInputRef.current?.click()} title={t('chat.file')} disabled={readOnly}>📎</button>
                                    <button className="btn-icon" onClick={startRecording} title={t('chat.voice')} disabled={readOnly}>🎤</button>

                                    <textarea
                                        className="input"
                                        placeholder={t('chat.typeMessage')}
                                        value={messageText}
                                        onChange={(e) => { setMessageText(e.target.value); handleTyping(); }}
                                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
                                        disabled={readOnly}
                                        rows={1}
                                    />

                                    <button className="send-btn" onClick={handleSendMessage} disabled={readOnly || !messageText.trim()}>➤</button>
                                </div>
                            )}
                        </div>}
                    </>
                )}
            </div>

            {/* ═══ Profile Modal ═══ */}
            {showProfile && user && (
                <ProfilePanel
                    user={user}
                    onClose={() => setShowProfile(false)}
                    onUpdate={(data) => {
                        handleProfileUpdate(data);
                        // Don't close — let user continue editing
                    }}
                />
            )}

            {/* ═══ NEW CHAT MODAL ═══ */}
            {showNewChat && (
                <div className="modal-overlay" onClick={() => setShowNewChat(false)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <h3>✏️ {contactSearchTitle}</h3>
                        <div className="input-group">
                            <input className="input" placeholder={contactSearchPlaceholder} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} autoFocus />
                        </div>
                        <div className="search-results">
                            {searchResults.map((u) => (
                                <div key={u.id} className="search-result-item" onClick={() => handleCreatePrivateChat(u.id)}>
                                    <div className={`avatar avatar-sm ${getAvatarClass(u.id)}`}>
                                        {u.avatarUrl ? <img src={u.avatarUrl} alt="" /> : getInitials(u.displayName || u.username)}
                                    </div>
                                    <div className="search-result-info">
                                        <div className="search-result-name">{u.displayName || u.username || u.id}{u.isVerified && <VerifiedBadge />}</div>
                                        {u.username && <div className="search-result-username">@{u.username}</div>}
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => setShowNewChat(false)}>{t('common.cancel')}</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ NEW GROUP MODAL ═══ */}
            {(showNewGroup || showNewChannel) && (
                <div className="modal-overlay" onClick={() => { setShowNewGroup(false); setShowNewChannel(false); }}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <h3>{showNewChannel ? 'Создать канал' : t('chat.newGroup')}</h3>
                        <div className="input-group" style={{ marginBottom: 12 }}>
                            <label className="input-label">{showNewChannel ? 'Название канала' : t('chat.groupName')}</label>
                            <input className="input" value={groupName} onChange={(e) => setGroupName(e.target.value)} autoFocus />
                        </div>
                        <div className="input-group">
                            <label className="input-label">{t('chat.selectMembersOptional')}</label>
                            <input className="input" placeholder={t('chat.searchUsers')} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
                        </div>
                        <div className="search-results">
                            {searchResults.map((u) => {
                                const isSelected = selectedMembers.includes(u.id);
                                return (
                                    <div key={u.id} className={`search-result-item ${isSelected ? 'selected' : ''}`} onClick={() => {
                                        setSelectedMembers((p) => isSelected ? p.filter((id) => id !== u.id) : [...p, u.id]);
                                    }}>
                                        <div className={`avatar avatar-sm ${getAvatarClass(u.id)}`}>
                                            {u.avatarUrl ? <img src={u.avatarUrl} alt="" /> : getInitials(u.displayName || u.username)}
                                        </div>
                                        <div className="search-result-info">
                                            <div className="search-result-name">{u.displayName || u.username || u.id}{u.isVerified && <VerifiedBadge />}</div>
                                        </div>
                                        {isSelected && <span className="search-result-check">✓</span>}
                                    </div>
                                );
                            })}
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => { setShowNewGroup(false); setShowNewChannel(false); }}>{t('common.cancel')}</button>
                            <button className="btn btn-primary" onClick={showNewChannel ? handleCreateChannel : handleCreateGroup} disabled={!groupName.trim()}>
                                {t('chat.create')}{selectedMembers.length > 0 ? ` (${selectedMembers.length})` : ''}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
