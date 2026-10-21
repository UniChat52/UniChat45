import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { config } from './config';
import { prisma } from './utils/prisma';
import { redis } from './utils/redis';
import { initMinio } from './utils/minio';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { chatRoutes } from './routes/chats';
import { messageRoutes } from './routes/messages';
import { fileRoutes } from './routes/files';
import { adminRoutes } from './routes/admin';
import { setupSocket } from './socket';
import { verifyAccessToken } from './utils/jwt';
import { getSystemSettings, isMaintenanceAllowed, isReadOnlyExempt } from './utils/systemSettings';

const app = Fastify({
    logger: {
        level: config.nodeEnv === 'production' ? 'info' : 'debug',
        transport: config.nodeEnv !== 'production' ? { target: 'pino-pretty' } : undefined,
    },
    trustProxy: true,
});

async function bootstrap() {
    // ── Plugins ──
    await app.register(cors, {
        origin: true,
        credentials: true,
    });

    await app.register(helmet, {
        contentSecurityPolicy: false,
    });

    await app.register(rateLimit, {
        max: config.rateLimit.max,
        timeWindow: config.rateLimit.timeWindow,
    });

    await app.register(cookie, {
        secret: config.jwt.accessSecret,
    });

    await app.register(multipart, {
        limits: {
            fileSize: 50 * 1024 * 1024, // 50MB
        },
    });

    app.addHook('preHandler', async (request, reply) => {
        const path = request.url.split('?')[0];
        if (path === '/api/health' || path === '/api/system/status' || request.method === 'OPTIONS') return;

        const settings = await getSystemSettings();
        const isAuthFlow = path.startsWith('/api/auth/');
        const isAuthRefresh = path === '/api/auth/refresh';
        const authorization = request.headers.authorization;
        let currentUser: { id: string; username: string | null } | null = null;
        if (authorization?.startsWith('Bearer ')) {
            try {
                const payload = verifyAccessToken(authorization.slice(7));
                currentUser = await prisma.user.findUnique({
                    where: { id: payload.userId, isBlocked: false },
                    select: { id: true, username: true },
                });
            } catch {
                currentUser = null;
            }
        }

        if (settings.maintenanceMode && !isMaintenanceAllowed(currentUser, settings.maintenanceUserIds) && !isAuthRefresh) {
            return reply.status(503).send({
                maintenanceMode: true,
                message: 'Ремонтные работы!🛠️ Скоро все уладим😊!',
            });
        }

        const isWriteRequest = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
        const isSystemModeChange = path === '/api/admin/settings/system' && request.method === 'PATCH';
        const isContactLookup = path === '/api/users/contacts/lookup' && request.method === 'POST';
        if (settings.readOnly && isWriteRequest && !isSystemModeChange && !isContactLookup && !isAuthFlow && !isReadOnlyExempt(currentUser, settings.readOnlyUserIds)) {
            return reply.status(423).send({ readOnly: true, error: 'Мессенджер работает в режиме чтения' });
        }
    });

    // ── Health ──
    app.get('/api/health', async () => {
        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            services: {
                database: await prisma.$queryRaw`SELECT 1`.then(() => 'ok').catch(() => 'error'),
                redis: await redis.ping().then(() => 'ok').catch(() => 'error'),
            },
        };
    });

    app.get('/api/system/status', async (request) => {
        const settings = await getSystemSettings();
        const authorization = request.headers.authorization;
        let currentUser: { id: string; username: string | null } | null = null;
        if (authorization?.startsWith('Bearer ')) {
            try {
                const payload = verifyAccessToken(authorization.slice(7));
                currentUser = await prisma.user.findUnique({
                    where: { id: payload.userId, isBlocked: false },
                    select: { id: true, username: true },
                });
            } catch {
                currentUser = null;
            }
        }
        return {
            readOnly: settings.readOnly && !isReadOnlyExempt(currentUser, settings.readOnlyUserIds),
            maintenanceMode: settings.maintenanceMode,
            allowed: !settings.maintenanceMode || isMaintenanceAllowed(currentUser, settings.maintenanceUserIds),
        };
    });

    // ── Routes ──
    await app.register(authRoutes, { prefix: '/api/auth' });
    await app.register(userRoutes, { prefix: '/api/users' });
    await app.register(chatRoutes, { prefix: '/api/chats' });
    await app.register(messageRoutes, { prefix: '/api/messages' });
    await app.register(fileRoutes, { prefix: '/api/files' });
    await app.register(adminRoutes, { prefix: '/api/admin' });

    // ── Init services ──
    await initMinio();

    // ── Socket.IO ──
    const httpServer = app.server;
    const io = new SocketServer(httpServer, {
        cors: {
            origin: true,
            credentials: true,
        },
        path: '/socket.io/',
    });

    app.decorate('io', io);
    setupSocket(io);

    // ── Start ──
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`🚀 UniChat backend running on port ${config.port}`);
}

bootstrap().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
});

// Graceful shutdown
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
signals.forEach((signal) => {
    process.on(signal, async () => {
        console.log(`\n${signal} received. Shutting down...`);
        await app.close();
        await prisma.$disconnect();
        redis.disconnect();
        process.exit(0);
    });
});
