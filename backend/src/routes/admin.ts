import { FastifyInstance } from 'fastify';
import { prisma } from '../utils/prisma';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { getSystemSettings, isMaintenanceAllowed } from '../utils/systemSettings';

export async function adminRoutes(app: FastifyInstance) {
    app.addHook('preHandler', authMiddleware);
    app.addHook('preHandler', adminMiddleware);

    app.get('/settings/system', async (_request, reply) => {
        const settings = await getSystemSettings();
        return reply.send({
            readOnly: settings.readOnly,
            readOnlyUserIds: settings.readOnlyUserIds,
            maintenanceMode: settings.maintenanceMode,
            maintenanceUserIds: settings.maintenanceUserIds,
        });
    });

    app.patch('/settings/system', async (request, reply) => {
        const body = request.body as {
            readOnly?: unknown;
            readOnlyUserIds?: unknown;
            maintenanceMode?: unknown;
            maintenanceUserIds?: unknown;
        };
        const current = await getSystemSettings();
        const data = {
            readOnly: typeof body.readOnly === 'boolean' ? body.readOnly : current.readOnly,
            readOnlyUserIds: Array.isArray(body.readOnlyUserIds)
                ? [...new Set(body.readOnlyUserIds.filter((id): id is string => typeof id === 'string'))]
                : current.readOnlyUserIds,
            maintenanceMode: typeof body.maintenanceMode === 'boolean' ? body.maintenanceMode : current.maintenanceMode,
            maintenanceUserIds: Array.isArray(body.maintenanceUserIds)
                ? [...new Set(body.maintenanceUserIds.filter((id): id is string => typeof id === 'string'))]
                : current.maintenanceUserIds,
        };
        if (data.maintenanceUserIds.length) {
            const existingUsers = await prisma.user.findMany({ where: { id: { in: data.maintenanceUserIds } }, select: { id: true } });
            data.maintenanceUserIds = data.maintenanceUserIds.filter((id) => existingUsers.some((user) => user.id === id));
        }
        if (data.readOnlyUserIds.length) {
            const existingUsers = await prisma.user.findMany({ where: { id: { in: data.readOnlyUserIds } }, select: { id: true } });
            data.readOnlyUserIds = data.readOnlyUserIds.filter((id) => existingUsers.some((user) => user.id === id));
        }
        const updated = await prisma.systemSettings.upsert({ where: { id: 'system' }, create: { id: 'system', ...data }, update: data });
        const io = (request.server as any).io;
        io.emit('system:read-only', { enabled: updated.readOnly, allowedUserIds: updated.readOnlyUserIds });
        io.emit('system:maintenance', { enabled: updated.maintenanceMode });

        if (updated.maintenanceMode) {
            const users = await prisma.user.findMany({ select: { id: true, username: true } });
            users.filter((user) => !isMaintenanceAllowed(user, updated.maintenanceUserIds))
                .forEach((user) => io.in(`user:${user.id}`).disconnectSockets(true));
        }

        return reply.send({
            readOnly: updated.readOnly,
            readOnlyUserIds: updated.readOnlyUserIds,
            maintenanceMode: updated.maintenanceMode,
            maintenanceUserIds: updated.maintenanceUserIds,
        });
    });

    // ── Get all users ──
    app.get('/users', async (request, reply) => {
        const { page = '1', limit = '20', search } = request.query as {
            page?: string;
            limit?: string;
            search?: string;
        };

        const take = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
        const currentPage = Math.max(parseInt(page) || 1, 1);
        const skip = (currentPage - 1) * take;

        const where = search
            ? {
                OR: [
                    { username: { contains: search, mode: 'insensitive' as const } },
                    { displayName: { contains: search, mode: 'insensitive' as const } },
                    { phone: { contains: search } },
                ],
            }
            : {};

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                select: {
                    id: true,
                    phone: true,
                    username: true,
                    displayName: true,
                    isAdmin: true,
                    isBlocked: true,
                    isVerified: true,
                    createdAt: true,
                    _count: { select: { messages: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take,
            }),
            prisma.user.count({ where }),
        ]);

        return reply.send({ users, total, page: currentPage, limit: take });
    });

    // ── Block/unblock user ──
    app.patch('/users/:id/block', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { blocked } = request.body as { blocked: boolean };

        if (id === request.user!.id) return reply.status(400).send({ error: 'Cannot block your own account' });

        const user = await prisma.user.update({
            where: { id },
            data: { isBlocked: blocked },
        });

        // If blocking, invalidate sessions
        if (blocked) {
            await prisma.session.deleteMany({ where: { userId: id } });
            (request.server as any).io.in(`user:${id}`).disconnectSockets(true);
        }

        return reply.send({ success: true, isBlocked: user.isBlocked });
    });

    app.patch('/users/:id/verify', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { verified } = request.body as { verified?: unknown };
        if (typeof verified !== 'boolean') return reply.status(400).send({ error: 'Не указано состояние верификации аккаунта' });

        const user = await prisma.user.update({ where: { id }, data: { isVerified: verified }, select: { id: true, isVerified: true } });
        return reply.send({ success: true, isVerified: user.isVerified });
    });

    app.delete('/users/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        if (id === request.user!.id) return reply.status(400).send({ error: 'Cannot delete your own account' });

        const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
        if (!user) return reply.status(404).send({ error: 'User not found' });

        (request.server as any).io.in(`user:${id}`).disconnectSockets(true);
        await prisma.user.delete({ where: { id } });
        await prisma.chat.deleteMany({ where: { members: { none: {} } } });
        return reply.send({ success: true });
    });

    app.get('/channels', async (_request, reply) => {
        const channels = await prisma.chat.findMany({
            where: { type: 'CHANNEL' },
            include: {
                members: { include: { user: { select: { id: true, username: true, displayName: true } } } },
                _count: { select: { messages: true, members: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
        return reply.send(channels);
    });

    app.patch('/channels/:id/block', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { blocked } = request.body as { blocked: boolean };
        const channel = await prisma.chat.findFirst({ where: { id, type: 'CHANNEL' }, include: { members: { select: { userId: true } } } });
        if (!channel) return reply.status(404).send({ error: 'Channel not found' });

        const updated = await prisma.chat.update({ where: { id }, data: { isBlocked: blocked } });
        const io = (request.server as any).io;
        if (blocked) {
            channel.members.forEach(({ userId }) => io.to(`user:${userId}`).emit('chat:removed', { chatId: id }));
            io.in(`chat:${id}`).socketsLeave(`chat:${id}`);
        } else {
            const restored = await prisma.chat.findUnique({
                where: { id },
                include: { members: { include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } } } },
            });
            if (restored) channel.members.forEach(({ userId }) => io.to(`user:${userId}`).emit('chat:new', restored));
        }
        return reply.send({ success: true, isBlocked: updated.isBlocked });
    });

    app.patch('/channels/:id/verify', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { verified } = request.body as { verified?: unknown };
        if (typeof verified !== 'boolean') return reply.status(400).send({ error: 'Не указано состояние верификации канала' });

        const channel = await prisma.chat.findFirst({ where: { id, type: 'CHANNEL' }, select: { id: true } });
        if (!channel) return reply.status(404).send({ error: 'Канал не найден' });
        const updated = await prisma.chat.update({ where: { id }, data: { isVerified: verified }, select: { isVerified: true } });
        return reply.send({ success: true, isVerified: updated.isVerified });
    });

    app.delete('/channels/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const channel = await prisma.chat.findFirst({ where: { id, type: 'CHANNEL' }, include: { members: { select: { userId: true } } } });
        if (!channel) return reply.status(404).send({ error: 'Channel not found' });

        const io = (request.server as any).io;
        channel.members.forEach(({ userId }) => io.to(`user:${userId}`).emit('chat:removed', { chatId: id }));
        io.in(`chat:${id}`).socketsLeave(`chat:${id}`);
        await prisma.chat.delete({ where: { id } });
        return reply.send({ success: true });
    });

    // ── Get reports ──
    app.get('/reports', async (request, reply) => {
        const { resolved = 'false' } = request.query as { resolved?: string };

        const reports = await prisma.report.findMany({
            where: { resolved: resolved === 'true' },
            include: {
                reporter: {
                    select: { id: true, username: true, displayName: true },
                },
                reported: {
                    select: { id: true, username: true, displayName: true },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        return reply.send(reports);
    });

    // ── Resolve report ──
    app.patch('/reports/:id/resolve', async (request, reply) => {
        const { id } = request.params as { id: string };

        await prisma.report.update({
            where: { id },
            data: { resolved: true },
        });

        return reply.send({ success: true });
    });

    // ── Stats ──
    app.get('/stats', async (request, reply) => {
        const [totalUsers, totalChats, totalMessages, activeReports] = await Promise.all([
            prisma.user.count(),
            prisma.chat.count(),
            prisma.message.count(),
            prisma.report.count({ where: { resolved: false } }),
        ]);

        return reply.send({ totalUsers, totalChats, totalMessages, activeReports });
    });
}
