import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authMiddleware } from '../middleware/auth';

const updateProfileSchema = z.object({
    username: z.string().min(5).max(32).regex(/^(?=.*[a-zA-Z])(?!_)(?!.*__)(?!.*_$)[a-zA-Z0-9_]+$/).nullable().optional(),
    displayName: z.string().min(1).max(64).optional(),
    lastName: z.string().max(64).nullable().optional(),
    bio: z.string().max(500).optional(),
    locale: z.enum(['ru', 'en']).optional(),
});

const lookupContactsSchema = z.object({
    phones: z.array(z.string().min(1).max(40)).max(500),
});

function normalizePhone(phone: string) {
    return phone.replace(/[^\d+]/g, '');
}

export async function userRoutes(app: FastifyInstance) {
    // All routes require auth
    app.addHook('preHandler', authMiddleware);

    // ── Update profile ──
    app.patch('/profile', async (request, reply) => {
        const body = updateProfileSchema.parse(request.body);

        if (body.username) {
            const existing = await prisma.user.findFirst({ where: { username: { equals: body.username, mode: 'insensitive' } } });
            if (existing && existing.id !== request.user!.id) {
                return reply.status(409).send({ error: 'Это имя пользователя уже занято' });
            }
        }

        const user = await prisma.user.update({
            where: { id: request.user!.id },
            data: body,
            select: {
                id: true,
                phone: true,
                username: true,
                displayName: true,
                lastName: true,
                avatarUrl: true,
                bio: true,
                isVerified: true,
                locale: true,
            },
        });

        return reply.send(user);
    });

    app.post('/contacts/lookup', async (request, reply) => {
        const body = lookupContactsSchema.parse(request.body);
        const phones = [...new Set(body.phones.map(normalizePhone).filter((phone) => phone.replace(/\D/g, '').length >= 6))];
        if (!phones.length) return reply.send([]);

        const users = await prisma.user.findMany({
            where: {
                phone: { in: phones },
                id: { not: request.user!.id },
                isBlocked: false,
            },
            select: {
                id: true,
                phone: true,
                username: true,
                displayName: true,
                avatarUrl: true,
                isVerified: true,
            },
        });

        return reply.send(users);
    });

    app.get('/blocked', async (request, reply) => {
        const blocks = await prisma.block.findMany({
            where: { blockerId: request.user!.id },
            select: { id: true },
        });
        return reply.send(blocks);
    });

    // ── Search users ──
    app.get('/search', async (request, reply) => {
        const { q } = request.query as { q?: string };
        if (!q || q.length < 2) {
            return reply.send([]);
        }

        const users = await prisma.user.findMany({
            where: {
                OR: [
                    { username: { contains: q, mode: 'insensitive' } },
                    { displayName: { contains: q, mode: 'insensitive' } },
                    { phone: { contains: q } },
                ],
                id: { not: request.user!.id },
                isBlocked: false,
            },
            select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
                bio: true,
                isVerified: true,
            },
            take: 20,
        });

        return reply.send(users);
    });

    // ── Get user by ID ──
    app.get('/:id', async (request, reply) => {
        const { id } = request.params as { id: string };

        const user = await prisma.user.findUnique({
            where: { id },
            select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
                bio: true,
                isVerified: true,
                createdAt: true,
            },
        });

        if (!user) {
            return reply.status(404).send({ error: 'User not found' });
        }

        return reply.send(user);
    });

    // ── Block user ──
    app.post('/block/:id', async (request, reply) => {
        const { id } = request.params as { id: string };

        if (id === request.user!.id) {
            return reply.status(400).send({ error: 'Cannot block yourself' });
        }

        await prisma.block.upsert({
            where: {
                blockerId_blockedId: {
                    blockerId: request.user!.id,
                    blockedId: id,
                },
            },
            create: {
                blockerId: request.user!.id,
                blockedId: id,
            },
            update: {},
        });

        return reply.send({ success: true });
    });

    // ── Unblock user ──
    app.delete('/block/:id', async (request, reply) => {
        const { id } = request.params as { id: string };

        await prisma.block.deleteMany({
            where: {
                blockerId: request.user!.id,
                blockedId: id,
            },
        });

        return reply.send({ success: true });
    });

    // ── Report user ──
    app.post('/report/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { reason, details } = request.body as { reason: string; details?: string };

        const validReasons = ['SPAM', 'HARASSMENT', 'INAPPROPRIATE', 'OTHER'];
        if (!validReasons.includes(reason)) {
            return reply.status(400).send({ error: 'Invalid reason' });
        }

        await prisma.report.create({
            data: {
                reporterId: request.user!.id,
                reportedId: id,
                reason: reason as any,
                details,
            },
        });

        return reply.send({ success: true });
    });

    // ── Delete account (GDPR/152-ФЗ) ──
    // ⚠️ ЮРИСТ: Проверить процедуру удаления ПД по 152-ФЗ
    app.delete('/account', async (request, reply) => {
        const userId = request.user!.id;

        // Soft-delete: mark data as deleted
        await prisma.user.update({
            where: { id: userId },
            data: {
                displayName: 'Deleted User',
                username: null,
                bio: null,
                avatarUrl: null,
                phone: `deleted_${userId}`,
                dataDeletedAt: new Date(),
                isBlocked: true,
            },
        });

        // Delete sessions
        await prisma.session.deleteMany({ where: { userId } });
        await prisma.device.deleteMany({ where: { userId } });

        return reply.send({ success: true, message: 'Account deleted' });
    });
}
