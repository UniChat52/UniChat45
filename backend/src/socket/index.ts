import { Server, Socket } from 'socket.io';
import { verifyAccessToken } from '../utils/jwt';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { getSystemSettings, isMaintenanceAllowed, isReadOnlyExempt } from '../utils/systemSettings';

interface AuthenticatedSocket extends Socket {
    userId?: string;
    username?: string | null;
    sessionId?: string;
}

export function setupSocket(io: Server) {
    // ── Auth middleware ──
    io.use(async (socket: AuthenticatedSocket, next) => {
        try {
            const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
            if (!token) {
                return next(new Error('Authentication required'));
            }

            const payload = verifyAccessToken(token);
            const settings = await getSystemSettings();
            const session = await prisma.session.findUnique({
                where: { id: payload.sessionId },
                select: { userId: true, expiresAt: true },
            });
            const user = await prisma.user.findUnique({
                where: { id: payload.userId },
                select: { id: true, username: true, isBlocked: true },
            });

            if (!session || session.userId !== payload.userId || session.expiresAt <= new Date() || !user || user.isBlocked) {
                return next(new Error('Unauthorized'));
            }
            if (settings.maintenanceMode && !isMaintenanceAllowed(user, settings.maintenanceUserIds)) {
                return next(new Error('Maintenance mode'));
            }

            socket.userId = user.id;
            socket.username = user.username;
            socket.sessionId = payload.sessionId;
            next();
        } catch (err) {
            next(new Error('Invalid token'));
        }
    });

    io.on('connection', async (socket: AuthenticatedSocket) => {
        const userId = socket.userId!;
        const readOnlyBlocksUser = async () => {
            const settings = await getSystemSettings();
            return settings.readOnly && !isReadOnlyExempt({ id: userId, username: socket.username ?? null }, settings.readOnlyUserIds);
        };
        console.log(`🔌 User connected: ${userId}`);

        // Join user's personal room
        socket.join(`user:${userId}`);
        socket.join(`session:${socket.sessionId}`);

        // Set online status
        await redis.set(`user:online:${userId}`, Date.now().toString(), 'EX', 300);

        // Join all user's chat rooms
        const memberships = await prisma.chatMember.findMany({
            where: { userId, chat: { isBlocked: false } },
            select: { chatId: true },
        });
        memberships.forEach(m => socket.join(`chat:${m.chatId}`));

        // Broadcast online status to contacts
        broadcastOnlineStatus(io, userId, true);

        // ── Send message ──
        socket.on('message:send', async (data, callback) => {
            try {
                if (await readOnlyBlocksUser()) return callback?.({ error: 'Мессенджер работает в режиме чтения' });
                const { chatId, content, type = 'TEXT', replyToId, fileUrl, fileName, fileSize, mimeType, duration } = data;

                // Verify membership
                const member = await prisma.chatMember.findFirst({
                    where: { chatId, userId },
                });
                if (!member) {
                    return callback?.({ error: 'Not a member' });
                }
                const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { isBlocked: true } });
                if (!chat || chat.isBlocked) return callback?.({ error: 'Chat unavailable' });

                const message = await prisma.message.create({
                    data: {
                        chatId,
                        senderId: userId,
                        type,
                        content,
                        replyToId,
                        fileUrl,
                        fileName,
                        fileSize,
                        mimeType,
                        duration,
                    },
                    include: {
                        sender: {
                            select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true },
                        },
                        replyTo: {
                            select: {
                                id: true,
                                content: true,
                                sender: { select: { displayName: true, isVerified: true } },
                            },
                        },
                    },
                });

                await prisma.chat.update({
                    where: { id: chatId },
                    data: { updatedAt: new Date() },
                });

                // Broadcast to chat room
                io.to(`chat:${chatId}`).emit('message:new', message);

                callback?.({ success: true, message });
            } catch (err: any) {
                callback?.({ error: err.message });
            }
        });

        socket.on('message:react', async (data, callback) => {
            try {
                if (await readOnlyBlocksUser()) return callback?.({ error: 'Мессенджер работает в режиме чтения' });
                const { messageId, emoji } = data as { messageId: string; emoji: string };
                if (!['👍', '❤️', '😂', '🔥', '😢', '😍', '👌'].includes(emoji)) return callback?.({ error: 'Invalid reaction' });
                const message = await prisma.message.findFirst({
                    where: { id: messageId, chat: { isBlocked: false, members: { some: { userId } } } },
                    select: { id: true, chatId: true },
                });
                if (!message) return callback?.({ error: 'Message unavailable' });
                const existing = await prisma.messageReaction.findUnique({
                    where: { messageId_userId_emoji: { messageId, userId, emoji } },
                });
                if (existing) await prisma.messageReaction.delete({ where: { id: existing.id } });
                else await prisma.messageReaction.create({ data: { messageId, userId, emoji } });
                const reactions = await prisma.messageReaction.findMany({ where: { messageId }, select: { userId: true, emoji: true } });
                io.to(`chat:${message.chatId}`).emit('message:reactions', { messageId, chatId: message.chatId, reactions });
                callback?.({ success: true });
            } catch (err: any) {
                callback?.({ error: err.message });
            }
        });

        // ── Typing indicator ──
        socket.on('typing:start', async (data) => {
            if (await readOnlyBlocksUser()) return;
            socket.to(`chat:${data.chatId}`).emit('typing:start', {
                chatId: data.chatId,
                userId,
            });
        });

        socket.on('typing:stop', (data) => {
            socket.to(`chat:${data.chatId}`).emit('typing:stop', {
                chatId: data.chatId,
                userId,
            });
        });

        // ── Message read ──
        socket.on('message:read', async (data) => {
            const { chatId } = data;

            await prisma.chatMember.updateMany({
                where: { chatId, userId },
                data: { lastReadAt: new Date() },
            });

            socket.to(`chat:${chatId}`).emit('message:read', {
                chatId,
                userId,
                readAt: new Date(),
            });
        });

        // ── Message edit ──
        socket.on('message:edit', async (data, callback) => {
            try {
                if (await readOnlyBlocksUser()) return callback?.({ error: 'Мессенджер работает в режиме чтения' });
                const { messageId, content } = data;

                const message = await prisma.message.findUnique({ where: { id: messageId } });
                if (!message || message.senderId !== userId) {
                    return callback?.({ error: 'Cannot edit' });
                }

                const updated = await prisma.message.update({
                    where: { id: messageId },
                    data: { content, editedAt: new Date() },
                    include: {
                        sender: {
                            select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true },
                        },
                    },
                });

                io.to(`chat:${message.chatId}`).emit('message:edited', updated);
                callback?.({ success: true });
            } catch (err: any) {
                callback?.({ error: err.message });
            }
        });

        // ── Message delete ──
        socket.on('message:delete', async (data, callback) => {
            try {
                if (await readOnlyBlocksUser()) return callback?.({ error: 'Мессенджер работает в режиме чтения' });
                const { messageId } = data;

                const message = await prisma.message.findUnique({ where: { id: messageId } });
                if (!message || message.senderId !== userId) {
                    return callback?.({ error: 'Cannot delete' });
                }

                await prisma.message.update({
                    where: { id: messageId },
                    data: { deletedAt: new Date() },
                });

                io.to(`chat:${message.chatId}`).emit('message:deleted', {
                    messageId,
                    chatId: message.chatId,
                });

                callback?.({ success: true });
            } catch (err: any) {
                callback?.({ error: err.message });
            }
        });

        // ── Join chat room (when new chat created) ──
        socket.on('chat:join', async (data) => {
            const member = await prisma.chatMember.findFirst({
                where: { chatId: data.chatId, userId, chat: { isBlocked: false } },
                select: { id: true },
            });
            if (member) socket.join(`chat:${data.chatId}`);
        });

        // ── Heartbeat for online status ──
        const heartbeat = setInterval(async () => {
            await redis.set(`user:online:${userId}`, Date.now().toString(), 'EX', 300);
        }, 60000);

        // ── Disconnect ──
        socket.on('disconnect', async () => {
            console.log(`🔌 User disconnected: ${userId}`);
            clearInterval(heartbeat);
            await redis.del(`user:online:${userId}`);
            await prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
            broadcastOnlineStatus(io, userId, false);
        });
    });
}

async function broadcastOnlineStatus(io: Server, userId: string, isOnline: boolean) {
    // Get all chats this user is in
    const memberships = await prisma.chatMember.findMany({
        where: { userId },
        select: { chatId: true },
    });

    memberships.forEach(m => {
        io.to(`chat:${m.chatId}`).emit('user:status', {
            userId,
            isOnline,
            lastSeen: new Date(),
        });
    });
}
