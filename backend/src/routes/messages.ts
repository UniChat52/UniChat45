import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authMiddleware } from '../middleware/auth';

const sendMessageSchema = z.object({
    chatId: z.string(),
    content: z.string().max(4096).optional(),
    type: z.enum(['TEXT', 'IMAGE', 'FILE', 'VOICE', 'SYSTEM']).default('TEXT'),
    replyToId: z.string().optional(),
    fileUrl: z.string().optional(),
    fileName: z.string().optional(),
    fileSize: z.number().optional(),
    mimeType: z.string().optional(),
    duration: z.number().optional(),
});

const editMessageSchema = z.object({
    content: z.string().max(4096),
});

export async function messageRoutes(app: FastifyInstance) {
    app.addHook('preHandler', authMiddleware);

    // ── Send message ──
    app.post('/', async (request, reply) => {
        const body = sendMessageSchema.parse(request.body);
        const myId = request.user!.id;

        // Check membership
        const member = await prisma.chatMember.findFirst({
            where: { chatId: body.chatId, userId: myId },
        });
        if (!member) {
            return reply.status(403).send({ error: 'Not a member of this chat' });
        }

        // Check blocks for private chats
        const chat = await prisma.chat.findUnique({ where: { id: body.chatId } });
        if (chat?.isBlocked) return reply.status(403).send({ error: 'Channel is blocked' });
        if (chat?.type === 'PRIVATE') {
            const otherMember = await prisma.chatMember.findFirst({
                where: { chatId: body.chatId, userId: { not: myId } },
            });
            if (otherMember) {
                const blocked = await prisma.block.findFirst({
                    where: {
                        OR: [
                            { blockerId: myId, blockedId: otherMember.userId },
                            { blockerId: otherMember.userId, blockedId: myId },
                        ],
                    },
                });
                if (blocked) {
                    return reply.status(403).send({ error: 'Cannot send message' });
                }
            }
        }

        const message = await prisma.message.create({
            data: {
                chatId: body.chatId,
                senderId: myId,
                type: body.type,
                content: body.content,
                replyToId: body.replyToId,
                fileUrl: body.fileUrl,
                fileName: body.fileName,
                fileSize: body.fileSize,
                mimeType: body.mimeType,
                duration: body.duration,
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
                reactions: { select: { userId: true, emoji: true } },
            },
        });

        // Update chat's updatedAt
        await prisma.chat.update({
            where: { id: body.chatId },
            data: { updatedAt: new Date() },
        });

        return reply.status(201).send(message);
    });

    // ── Get messages (with pagination) ──
    app.get('/:chatId', async (request, reply) => {
        const { chatId } = request.params as { chatId: string };
        const { cursor, limit = '50' } = request.query as { cursor?: string; limit?: string };
        const myId = request.user!.id;

        // Check membership
        const member = await prisma.chatMember.findFirst({
            where: { chatId, userId: myId },
        });
        if (!member) {
            return reply.status(403).send({ error: 'Not a member of this chat' });
        }

        const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { isBlocked: true } });
        if (!chat || chat.isBlocked) return reply.status(404).send({ error: 'Chat not found' });

        const take = Math.min(parseInt(limit), 100);

        const messages = await prisma.message.findMany({
            where: {
                chatId,
                deletedAt: null,
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
            orderBy: { createdAt: 'desc' },
            take,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });

        return reply.send({
            messages: messages.reverse(),
            nextCursor: messages.length === take ? messages[0]?.id : null,
        });
    });

    app.get('/:chatId/readers', async (request, reply) => {
        const { chatId } = request.params as { chatId: string };
        const { messageId } = request.query as { messageId?: string };
        const member = await prisma.chatMember.findFirst({ where: { chatId, userId: request.user!.id } });
        if (!member) return reply.status(403).send({ error: 'Not a member of this chat' });
        const message = await prisma.message.findFirst({ where: { id: messageId, chatId }, select: { createdAt: true } });
        if (!message) return reply.status(404).send({ error: 'Message not found' });
        const readers = await prisma.chatMember.findMany({
            where: { chatId, userId: { not: request.user!.id }, lastReadAt: { gte: message.createdAt } },
            select: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true } }, lastReadAt: true },
        });
        return reply.send(readers);
    });

    app.post('/:id/pin', async (request, reply) => {
        const { id } = request.params as { id: string };
        const message = await prisma.message.findFirst({
            where: { id, chat: { isBlocked: false, members: { some: { userId: request.user!.id } } } },
            include: { chat: { select: { type: true } } },
        });
        if (!message) return reply.status(404).send({ error: 'Message not found' });
        const member = await prisma.chatMember.findFirst({
            where: { chatId: message.chatId, userId: request.user!.id, role: { in: ['OWNER', 'ADMIN'] } },
            select: { id: true },
        });
        if (!member || message.chat.type !== 'GROUP') return reply.status(403).send({ error: 'Not authorized to pin messages' });
        const updated = await prisma.message.update({
            where: { id },
            data: { pinnedAt: message.pinnedAt ? null : new Date() },
            select: { id: true, chatId: true, pinnedAt: true },
        });
        (request.server as any).io.to(`chat:${message.chatId}`).emit('message:pinned', updated);
        return reply.send(updated);
    });

    // ── Edit message ──
    app.patch('/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = editMessageSchema.parse(request.body);
        const myId = request.user!.id;

        const message = await prisma.message.findUnique({ where: { id } });
        if (!message || message.senderId !== myId) {
            return reply.status(403).send({ error: 'Cannot edit this message' });
        }

        const updated = await prisma.message.update({
            where: { id },
            data: { content: body.content, editedAt: new Date() },
            include: {
                sender: {
                    select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true },
                },
            },
        });

        return reply.send(updated);
    });

    // ── Delete message (soft) ──
    app.delete('/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const myId = request.user!.id;

        const message = await prisma.message.findUnique({ where: { id } });
        if (!message || message.senderId !== myId) {
            return reply.status(403).send({ error: 'Cannot delete this message' });
        }

        await prisma.message.update({
            where: { id },
            data: { deletedAt: new Date() },
        });

        return reply.send({ success: true });
    });

    // ── Mark as read ──
    app.post('/:chatId/read', async (request, reply) => {
        const { chatId } = request.params as { chatId: string };
        const myId = request.user!.id;

        await prisma.chatMember.updateMany({
            where: { chatId, userId: myId },
            data: { lastReadAt: new Date() },
        });

        return reply.send({ success: true });
    });
}
