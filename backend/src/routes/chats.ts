import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { authMiddleware } from '../middleware/auth';

const createGroupSchema = z.object({
    name: z.string().min(1).max(128),
    memberIds: z.array(z.string()).max(200).default([]),
});

const updateGroupSchema = z.object({
    name: z.string().min(1).max(128).optional(),
});

export async function chatRoutes(app: FastifyInstance) {
    app.addHook('preHandler', authMiddleware);

    // ── Create private chat (1-on-1) ──
    app.post('/private', async (request, reply) => {
        const { userId } = request.body as { userId: string };
        const myId = request.user!.id;

        if (userId === myId) {
            return reply.status(400).send({ error: 'Cannot chat with yourself' });
        }

        // Check if blocked
        const blocked = await prisma.block.findFirst({
            where: {
                OR: [
                    { blockerId: myId, blockedId: userId },
                    { blockerId: userId, blockedId: myId },
                ],
            },
        });
        if (blocked) {
            return reply.status(403).send({ error: 'Cannot create chat with this user' });
        }

        // Check if private chat already exists
        const existingChat = await prisma.chat.findFirst({
            where: {
                type: 'PRIVATE',
                AND: [
                    { members: { some: { userId: myId } } },
                    { members: { some: { userId } } },
                ],
            },
            include: {
                members: {
                    include: {
                        user: {
                            select: { id: true, username: true, displayName: true, avatarUrl: true, lastSeenAt: true, isVerified: true },
                        },
                    },
                },
            },
        });

        if (existingChat) {
            return reply.send(existingChat);
        }

        // Create new private chat
        const chat = await prisma.chat.create({
            data: {
                type: 'PRIVATE',
                members: {
                    create: [
                        { userId: myId, role: 'MEMBER' },
                        { userId, role: 'MEMBER' },
                    ],
                },
            },
            include: {
                members: {
                    include: {
                        user: {
                            select: { id: true, username: true, displayName: true, avatarUrl: true, lastSeenAt: true, isVerified: true },
                        },
                    },
                },
            },
        });

        const io = (request.server as any).io;
        io.to(`user:${myId}`).emit('chat:new', chat);
        io.to(`user:${userId}`).emit('chat:new', chat);

        return reply.status(201).send(chat);
    });

    // ── Create group chat ──
    app.post('/group', async (request, reply) => {
        const body = createGroupSchema.parse(request.body);
        const myId = request.user!.id;

        const allMemberIds = [myId, ...body.memberIds.filter(id => id !== myId)];

        const chat = await prisma.chat.create({
            data: {
                type: 'GROUP',
                name: body.name,
                members: {
                    create: allMemberIds.map((userId, index) => ({
                        userId,
                        role: index === 0 ? 'OWNER' : 'MEMBER',
                    })),
                },
            },
            include: {
                members: {
                    include: {
                        user: {
                            select: { id: true, username: true, displayName: true, avatarUrl: true, lastSeenAt: true, isVerified: true },
                        },
                    },
                },
            },
        });

        const io = (request.server as any).io;
        allMemberIds.forEach((memberId) => {
            io.to(`user:${memberId}`).emit('chat:new', chat);
        });

        return reply.status(201).send(chat);
    });

    // ── Create channel ──
    app.post('/channel', async (request, reply) => {
        const body = createGroupSchema.parse(request.body);
        const myId = request.user!.id;
        const memberIds = [myId, ...body.memberIds.filter((id) => id !== myId)];

        const chat = await prisma.chat.create({
            data: {
                type: 'CHANNEL',
                name: body.name,
                members: { create: memberIds.map((userId, index) => ({ userId, role: index === 0 ? 'OWNER' : 'MEMBER' })) },
            },
            include: {
                members: {
                    include: {
                        user: { select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true } },
                    },
                },
            },
        });

        const io = (request.server as any).io;
        memberIds.forEach((memberId) => io.to(`user:${memberId}`).emit('chat:new', chat));
        return reply.status(201).send(chat);
    });

    // ── Get user's chats ──
    app.get('/', async (request, reply) => {
        const myId = request.user!.id;

        const chats = await prisma.chat.findMany({
            where: {
                isBlocked: false,
                members: { some: { userId: myId } },
            },
            include: {
                members: {
                    include: {
                        user: {
                            select: { id: true, username: true, displayName: true, avatarUrl: true, lastSeenAt: true, isVerified: true },
                        },
                    },
                },
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    select: {
                        id: true,
                        content: true,
                        type: true,
                        createdAt: true,
                        sender: {
                            select: { id: true, displayName: true },
                        },
                    },
                },
            },
            orderBy: { updatedAt: 'desc' },
        });

        const unreadConditions = chats.map((chat) => {
            const membership = chat.members.find((member) => member.userId === myId);
            return {
                chatId: chat.id,
                ...(membership?.lastReadAt ? { createdAt: { gt: membership.lastReadAt } } : {}),
            };
        });
        const unreadGroups = chats.length ? await prisma.message.groupBy({
            by: ['chatId'],
            where: { senderId: { not: myId }, OR: unreadConditions },
            _count: { _all: true },
        }) : [];
        const unreadByChat = new Map(unreadGroups.map((group) => [group.chatId, group._count._all]));

        const onlineEntries = await Promise.all([...new Set(chats.flatMap((chat) => chat.members.map((member) => member.userId)))].map(async (userId) => [
            userId,
            Boolean(await redis.get(`user:online:${userId}`)),
        ] as const));
        const onlineByUser = new Map(onlineEntries);
        return reply.send(chats.map((chat) => ({
            ...chat,
            unreadCount: unreadByChat.get(chat.id) || 0,
            members: chat.members.map((member) => ({
                ...member,
                user: { ...member.user, isOnline: onlineByUser.get(member.userId) || false },
            })),
        })));
    });

    // ── Get single chat ──
    app.get('/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const myId = request.user!.id;

        const chat = await prisma.chat.findFirst({
            where: {
                id,
                isBlocked: false,
                members: { some: { userId: myId } },
            },
            include: {
                members: {
                    include: {
                        user: {
                            select: { id: true, username: true, displayName: true, avatarUrl: true, bio: true, lastSeenAt: true, isVerified: true },
                        },
                    },
                },
            },
        });

        if (!chat) {
            return reply.status(404).send({ error: 'Chat not found' });
        }

        const members = await Promise.all(chat.members.map(async (member) => ({
            ...member,
            user: { ...member.user, isOnline: Boolean(await redis.get(`user:online:${member.userId}`)) },
        })));
        return reply.send({ ...chat, members });
    });

    app.post('/:id/unread', async (request, reply) => {
        const { id } = request.params as { id: string };
        const result = await prisma.chatMember.updateMany({
            where: { chatId: id, userId: request.user!.id },
            data: { lastReadAt: null },
        });
        if (!result.count) return reply.status(404).send({ error: 'Chat not found' });
        return reply.send({ success: true });
    });

    // ── Update group chat ──
    app.patch('/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = updateGroupSchema.parse(request.body);
        const myId = request.user!.id;

        // Check if user is owner or admin
        const member = await prisma.chatMember.findFirst({
            where: { chatId: id, userId: myId, role: { in: ['OWNER', 'ADMIN'] } },
        });

        if (!member) {
            return reply.status(403).send({ error: 'Not authorized' });
        }

        const chat = await prisma.chat.update({
            where: { id },
            data: body,
        });

        const io = (request.server as any).io;
        io.to(`chat:${id}`).emit('chat:updated', chat);

        return reply.send(chat);
    });

    // ── Add member to group ──
    app.post('/:id/members', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { userId } = request.body as { userId: string };
        const myId = request.user!.id;

        // Check permissions
        const member = await prisma.chatMember.findFirst({
            where: { chatId: id, userId: myId, role: { in: ['OWNER', 'ADMIN'] } },
        });
        if (!member) {
            return reply.status(403).send({ error: 'Not authorized' });
        }

        // Check chat type
        const chat = await prisma.chat.findUnique({ where: { id } });
        if (!chat || chat.type !== 'GROUP') {
            return reply.status(400).send({ error: 'Not a group chat' });
        }

        await prisma.chatMember.create({
            data: { chatId: id, userId, role: 'MEMBER' },
        });

        const io = (request.server as any).io;
        const updatedChat = await prisma.chat.findUnique({
            where: { id },
            include: {
                members: {
                    include: {
                        user: {
                            select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true },
                        },
                    },
                },
            },
        });
        if (updatedChat) {
            io.to(`user:${userId}`).emit('chat:new', updatedChat);
            io.to(`chat:${id}`).emit('chat:updated', updatedChat);
        }

        return reply.send({ success: true });
    });

    // ── Remove member from group ──
    app.delete('/:id/members/:userId', async (request, reply) => {
        const { id, userId } = request.params as { id: string; userId: string };
        const myId = request.user!.id;

        // Can remove self (leave) or admin/owner can remove others
        if (userId !== myId) {
            const member = await prisma.chatMember.findFirst({
                where: { chatId: id, userId: myId, role: { in: ['OWNER', 'ADMIN'] } },
            });
            if (!member) {
                return reply.status(403).send({ error: 'Not authorized' });
            }
        }

        await prisma.chatMember.deleteMany({
            where: { chatId: id, userId },
        });

        const io = (request.server as any).io;
        io.to(`user:${userId}`).emit('chat:removed', { chatId: id });
        io.in(`user:${userId}`).socketsLeave(`chat:${id}`);
        io.to(`chat:${id}`).emit('chat:updated', { chatId: id, userId, action: 'member-removed' });

        return reply.send({ success: true });
    });

    // ── Leave group ──
    app.post('/:id/leave', async (request, reply) => {
        const { id } = request.params as { id: string };
        const myId = request.user!.id;

        await prisma.chatMember.deleteMany({
            where: { chatId: id, userId: myId },
        });

        const io = (request.server as any).io;
        io.to(`user:${myId}`).emit('chat:removed', { chatId: id });
        io.in(`user:${myId}`).socketsLeave(`chat:${id}`);
        io.to(`chat:${id}`).emit('chat:updated', { chatId: id, userId: myId, action: 'member-left' });

        return reply.send({ success: true });
    });
}
