import { create } from 'zustand';
import { api } from '../services/api';
import { useChatStore } from './chat';

interface User {
    id: string;
    phone: string;
    username: string | null;
    displayName: string | null;
    lastName?: string | null;
    avatarUrl: string | null;
    bio?: string | null;
    isAdmin: boolean;
    isVerified: boolean;
    locale: string;
}

interface AuthState {
    user: User | null;
    isAuthenticated: boolean;
    isNewUser: boolean;
    hydrate: () => Promise<void>;
    setUser: (user: User) => void;
    setAuth: (data: { accessToken: string; refreshToken: string; user: User; isNewUser: boolean }) => void;
    logout: () => void;
    updateUser: (data: Partial<User>) => void;
}

const readStoredUser = (): User | null => {
    try {
        const raw = localStorage.getItem('auth:user');
        return raw ? JSON.parse(raw) as User : null;
    } catch {
        return null;
    }
};

export const useAuthStore = create<AuthState>((set) => ({
    user: readStoredUser(),
    isAuthenticated: !!localStorage.getItem('accessToken'),
    isNewUser: false,

    hydrate: async () => {
        const accessToken = localStorage.getItem('accessToken');
        if (!accessToken) {
            set({ user: null, isAuthenticated: false, isNewUser: false });
            return;
        }

        try {
            const me = await api.getMe();
            const user = me.user ?? me;
            localStorage.setItem('auth:user', JSON.stringify(user));
            set({ user, isAuthenticated: true, isNewUser: false });
        } catch {
            localStorage.removeItem('accessToken');
            localStorage.removeItem('refreshToken');
            localStorage.removeItem('auth:user');
            set({ user: null, isAuthenticated: false, isNewUser: false });
        }
    },

    setUser: (user) => {
        const currentUserId = useAuthStore.getState().user?.id;
        if (currentUserId && currentUserId !== user.id) {
            useChatStore.getState().clear();
        }
        localStorage.setItem('auth:user', JSON.stringify(user));
        set({ user, isAuthenticated: true });
    },

    setAuth: (data) => {
        if (useAuthStore.getState().user?.id !== data.user.id) useChatStore.getState().clear();
        localStorage.setItem('accessToken', data.accessToken);
        localStorage.setItem('refreshToken', data.refreshToken);
        localStorage.setItem('auth:user', JSON.stringify(data.user));
        set({
            user: data.user,
            isAuthenticated: true,
            isNewUser: data.isNewUser,
        });
    },

    logout: () => {
        useChatStore.getState().clear();
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('auth:user');
        set({ user: null, isAuthenticated: false, isNewUser: false });
    },

    updateUser: (data) =>
        set((state) => {
            const nextUser = state.user ? { ...state.user, ...data } : null;
            if (nextUser) localStorage.setItem('auth:user', JSON.stringify(nextUser));
            return { user: nextUser };
        }),
}));
