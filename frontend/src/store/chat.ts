import { create } from 'zustand';

interface Message {
    id: string;
    chatId: string;
    senderId: string;
    type: string;
    content: string | null;
    fileUrl: string | null;
    fileName: string | null;
    fileSize: number | null;
    mimeType: string | null;
    duration: number | null;
    replyToId: string | null;
    replyTo: any | null;
    editedAt: string | null;
    deletedAt: string | null;
    pinnedAt?: string | null;
    reactions?: { userId: string; emoji: string }[];
    createdAt: string;
    sender: {
        id: string;
        username: string | null;
        displayName: string | null;
        avatarUrl: string | null;
        isVerified?: boolean;
    };
}

interface Chat {
    id: string;
    type: 'PRIVATE' | 'GROUP' | 'CHANNEL';
    name: string | null;
    isVerified?: boolean;
    avatarUrl: string | null;
    members: any[];
    messages: any[];
    unreadCount?: number;
    updatedAt: string;
}

interface ChatState {
    chats: Chat[];
    activeChat: Chat | null;
    messages: Record<string, Message[]>;
    typingUsers: Record<string, string[]>;
    onlineUsers: Set<string>;
    lastSeenByUser: Record<string, string | null>;

    setChats: (chats: Chat[]) => void;
    setActiveChat: (chat: Chat | null) => void;
    addChat: (chat: Chat) => void;
    upsertChat: (chat: Chat) => void;
    removeChat: (chatId: string) => void;
    updateChatMeta: (chat: Partial<Chat> & { id: string }) => void;
    setMessages: (chatId: string, messages: Message[]) => void;
    addMessage: (message: Message) => void;
    updateMessage: (message: Message) => void;
    deleteMessage: (chatId: string, messageId: string) => void;
    setMessageReactions: (chatId: string, messageId: string, reactions: { userId: string; emoji: string }[]) => void;
    setMessagePinned: (chatId: string, messageId: string, pinnedAt: string | null) => void;
    clear: () => void;
    setTyping: (chatId: string, userId: string, isTyping: boolean) => void;
    setUserOnline: (userId: string, isOnline: boolean, lastSeenAt?: string | null) => void;
}

export const useChatStore = create<ChatState>((set) => ({
    chats: [],
    activeChat: null,
    messages: {},
    typingUsers: {},
    onlineUsers: new Set(),
    lastSeenByUser: {},

    clear: () => set({ chats: [], activeChat: null, messages: {}, typingUsers: {}, onlineUsers: new Set(), lastSeenByUser: {} }),

    setChats: (chats) => set({ chats }),

    setActiveChat: (chat) => set({ activeChat: chat }),

    addChat: (chat) =>
        set((state) => ({
            chats: [chat, ...state.chats.filter((c) => c.id !== chat.id)]
                .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
        })),

    upsertChat: (chat) =>
        set((state) => {
            const existing = state.chats.find((c) => c.id === chat.id);
            const chats = existing
                ? state.chats.map((c) => (c.id === chat.id ? { ...c, ...chat } : c))
                : [chat, ...state.chats];
            return {
                chats: chats.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
            };
        }),

    removeChat: (chatId) =>
        set((state) => ({
            chats: state.chats.filter((chat) => chat.id !== chatId),
            activeChat: state.activeChat?.id === chatId ? null : state.activeChat,
        })),

    updateChatMeta: (chat) =>
        set((state) => ({
            chats: state.chats.map((c) => (c.id === chat.id ? { ...c, ...chat } : c)),
            activeChat: state.activeChat && state.activeChat.id === chat.id ? { ...state.activeChat, ...chat } : state.activeChat,
        })),

    setMessages: (chatId, messages) =>
        set((state) => ({
            messages: { ...state.messages, [chatId]: messages },
        })),

    addMessage: (message) =>
        set((state) => {
            const existing = state.messages[message.chatId] || [];
            // Avoid duplicates
            if (existing.some((m) => m.id === message.id)) return state;

            const newMessages = {
                ...state.messages,
                [message.chatId]: [...existing, message],
            };

            const updatedChat = state.chats.find((chat) => chat.id === message.chatId);
            const newChats = updatedChat
                ? [
                    {
                        ...updatedChat,
                        updatedAt: message.createdAt,
                        messages: [{
                            id: message.id,
                            content: message.content,
                            type: message.type,
                            createdAt: message.createdAt,
                            sender: message.sender,
                        }],
                    },
                    ...state.chats.filter((chat) => chat.id !== message.chatId),
                ]
                : state.chats;

            return { messages: newMessages, chats: newChats };
        }),

    updateMessage: (message) =>
        set((state) => {
            const existing = state.messages[message.chatId] || [];
            const chat = state.chats.find((item) => item.id === message.chatId);
            const isLastMessage = chat?.messages?.[0]?.id === message.id;
            return {
                messages: {
                    ...state.messages,
                    [message.chatId]: existing.map((m) =>
                        m.id === message.id ? { ...m, ...message } : m
                    ),
                },
                chats: isLastMessage
                    ? state.chats.map((item) => item.id === message.chatId
                        ? { ...item, messages: [{ ...item.messages[0], ...message }] }
                        : item)
                    : state.chats,
            };
        }),

    deleteMessage: (chatId, messageId) =>
        set((state) => {
            const existing = state.messages[chatId] || [];
            const chat = state.chats.find((item) => item.id === chatId);
            const isLastMessage = chat?.messages?.[0]?.id === messageId;
            const deletedAt = new Date().toISOString();
            return {
                messages: {
                    ...state.messages,
                    [chatId]: existing.map((m) =>
                        m.id === messageId ? { ...m, deletedAt } : m
                    ),
                },
                chats: isLastMessage
                    ? state.chats.map((item) => item.id === chatId
                        ? { ...item, messages: [{ ...item.messages[0], content: null, deletedAt }] }
                        : item)
                    : state.chats,
            };
        }),

    setMessageReactions: (chatId, messageId, reactions) =>
        set((state) => ({
            messages: {
                ...state.messages,
                [chatId]: (state.messages[chatId] || []).map((message) =>
                    message.id === messageId ? { ...message, reactions } : message
                ),
            },
        })),

    setMessagePinned: (chatId, messageId, pinnedAt) =>
        set((state) => ({
            messages: {
                ...state.messages,
                [chatId]: (state.messages[chatId] || []).map((message) =>
                    message.id === messageId ? { ...message, pinnedAt } : message
                ),
            },
        })),

    setTyping: (chatId, userId, isTyping) =>
        set((state) => {
            const current = state.typingUsers[chatId] || [];
            const updated = isTyping
                ? [...new Set([...current, userId])]
                : current.filter((id) => id !== userId);
            return {
                typingUsers: { ...state.typingUsers, [chatId]: updated },
            };
        }),

    setUserOnline: (userId, isOnline, lastSeenAt) =>
        set((state) => {
            const newSet = new Set(state.onlineUsers);
            if (isOnline) newSet.add(userId);
            else newSet.delete(userId);
            return {
                onlineUsers: newSet,
                lastSeenByUser: lastSeenAt ? { ...state.lastSeenByUser, [userId]: lastSeenAt } : state.lastSeenByUser,
            };
        }),
}));
