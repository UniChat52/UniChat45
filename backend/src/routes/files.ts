import { FastifyInstance } from 'fastify';
import { prisma } from '../utils/prisma';
import { minioClient } from '../utils/minio';
import { authMiddleware } from '../middleware/auth';
import { config } from '../config';
import { randomUUID } from 'crypto';

// MIME type map for common file types
const MIME_MAP: Record<string, string> = {
    webm: 'audio/webm',
    ogg: 'audio/ogg',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    zip: 'application/zip',
};

function getMimeType(filename: string, fallback?: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return MIME_MAP[ext] || fallback || 'application/octet-stream';
}

export async function fileRoutes(app: FastifyInstance) {
    // ── Upload file (auth required) ──
    app.post('/upload', { preHandler: [authMiddleware] }, async (request, reply) => {
        const data = await request.file();
        if (!data) {
            return reply.status(400).send({ error: 'No file uploaded' });
        }

        const ext = data.filename.split('.').pop() || 'bin';
        const objectName = `${request.user!.id}/${randomUUID()}.${ext}`;
        const contentType = data.mimetype || getMimeType(data.filename);

        app.log.info(`📤 UPLOAD: filename=${data.filename}, mimetype=${data.mimetype}, ext=${ext}`);

        // Collect stream into buffer for reliable upload with known size
        const chunks: Buffer[] = [];
        for await (const chunk of data.file) {
            chunks.push(Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunks);

        app.log.info(`📤 UPLOAD: buffer size=${buffer.length} bytes, chunks=${chunks.length}, contentType=${contentType}`);

        if (buffer.length === 0) {
            app.log.error('📤 UPLOAD ERROR: Buffer is empty! File stream was consumed or empty.');
            return reply.status(400).send({ error: 'Uploaded file is empty' });
        }

        await minioClient.putObject(
            config.minio.bucket,
            objectName,
            buffer,
            buffer.length,
            { 'Content-Type': contentType }
        );

        // Verify the upload by checking the object stat
        try {
            const stat = await minioClient.statObject(config.minio.bucket, objectName);
            app.log.info(`📤 UPLOAD VERIFY: MinIO stat size=${stat.size}, metaData=${JSON.stringify(stat.metaData)}`);
            if (stat.size !== buffer.length) {
                app.log.error(`📤 UPLOAD MISMATCH: uploaded ${buffer.length} but MinIO has ${stat.size}`);
            }
        } catch (verifyErr) {
            app.log.error(`📤 UPLOAD VERIFY FAILED: ${verifyErr}`);
        }

        // Return URL that goes through our serve endpoint
        const fileUrl = `/api/files/serve/${objectName}`;

        return reply.send({
            url: fileUrl,
            fileName: data.filename,
            mimeType: contentType,
            objectName,
        });
    });

    // ── Upload avatar (auth required) ──
    app.post('/avatar', { preHandler: [authMiddleware] }, async (request, reply) => {
        const data = await request.file();
        if (!data) {
            return reply.status(400).send({ error: 'No file uploaded' });
        }

        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowedTypes.includes(data.mimetype)) {
            return reply.status(400).send({ error: 'Invalid file type. Use JPEG, PNG, or WebP.' });
        }

        const ext = data.filename.split('.').pop() || 'jpg';
        const objectName = `avatars/${request.user!.id}.${ext}`;

        const chunks: Buffer[] = [];
        for await (const chunk of data.file) {
            chunks.push(Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunks);

        await minioClient.putObject(
            config.minio.bucket,
            objectName,
            buffer,
            buffer.length,
            { 'Content-Type': data.mimetype }
        );

        const avatarUrl = `/api/files/serve/${objectName}`;

        await prisma.user.update({
            where: { id: request.user!.id },
            data: { avatarUrl },
        });

        return reply.send({ avatarUrl });
    });

    // ── Serve file from MinIO (NO auth — public access) ──
    app.get('/serve/*', async (request, reply) => {
        try {
            const objectName = (request.params as any)['*'];
            if (!objectName) {
                return reply.status(400).send({ error: 'No file specified' });
            }

            app.log.info(`📥 SERVE: objectName=${objectName}`);

            // Get object info for Content-Type
            let stat;
            try {
                stat = await minioClient.statObject(config.minio.bucket, objectName);
            } catch {
                app.log.error(`📥 SERVE: File not found in MinIO: ${objectName}`);
                return reply.status(404).send({ error: 'File not found' });
            }

            // Determine Content-Type: check MinIO metadata, then fallback to extension
            const metaCT = stat.metaData?.['content-type'];
            const contentType = metaCT || getMimeType(objectName);

            app.log.info(`📥 SERVE: stat.size=${stat.size}, metaCT=${metaCT}, finalCT=${contentType}`);

            // Buffer the entire file from MinIO (instead of streaming to avoid pipe issues)
            const stream = await minioClient.getObject(config.minio.bucket, objectName);
            const fileChunks: Buffer[] = [];
            for await (const chunk of stream) {
                fileChunks.push(Buffer.from(chunk as any));
            }
            const fileBuffer = Buffer.concat(fileChunks);

            app.log.info(`📥 SERVE: buffered ${fileBuffer.length} bytes to send`);

            reply.header('Content-Type', contentType);
            reply.header('Content-Length', fileBuffer.length);
            reply.header('Cache-Control', 'public, max-age=31536000, immutable');

            return reply.send(fileBuffer);
        } catch (err: any) {
            app.log.error(`📥 SERVE ERROR: ${err.message}`);
            return reply.status(500).send({ error: 'Failed to serve file' });
        }
    });
}
