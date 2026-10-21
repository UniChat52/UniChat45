import * as Minio from 'minio';
import { config } from '../config';

export const minioClient = new Minio.Client({
    endPoint: config.minio.endpoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
});

export async function initMinio() {
    const bucketExists = await minioClient.bucketExists(config.minio.bucket);
    if (!bucketExists) {
        await minioClient.makeBucket(config.minio.bucket, 'us-east-1');
        // Set public read policy for file serving
        const policy = {
            Version: '2012-10-17',
            Statement: [
                {
                    Effect: 'Allow',
                    Principal: { AWS: ['*'] },
                    Action: ['s3:GetObject'],
                    Resource: [`arn:aws:s3:::${config.minio.bucket}/*`],
                },
            ],
        };
        await minioClient.setBucketPolicy(config.minio.bucket, JSON.stringify(policy));
        console.log(`✅ MinIO bucket "${config.minio.bucket}" created`);
    } else {
        console.log(`✅ MinIO bucket "${config.minio.bucket}" exists`);
    }
}

export function getFileUrl(objectName: string): string {
    // Return a relative URL that goes through Nginx proxy
    return `/storage/${config.minio.bucket}/${objectName}`;
}
