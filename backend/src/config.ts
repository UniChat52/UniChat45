export const config = {
    port: parseInt(process.env.BACKEND_PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',

    database: {
        url: process.env.DATABASE_URL!,
    },

    redis: {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
    },

    jwt: {
        accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
        refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
        accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
        refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
    },

    minio: {
        endpoint: process.env.MINIO_ENDPOINT || 'localhost',
        port: parseInt(process.env.MINIO_PORT || '9000', 10),
        accessKey: process.env.MINIO_ROOT_USER || 'unichat',
        secretKey: process.env.MINIO_ROOT_PASSWORD || 'changeme',
        bucket: process.env.MINIO_BUCKET || 'unichat-files',
        useSSL: false,
    },

    verification: {
        codeLength: 6,
        codeExpiresMinutes: 5,
        maxAttempts: 5,
    },

    sms: {
        accountSid: process.env.TWILIO_ACCOUNT_SID || '',
        authToken: process.env.TWILIO_AUTH_TOKEN || '',
        fromNumber: process.env.TWILIO_FROM_NUMBER || '',
    },

    rateLimit: {
        max: 100,
        timeWindow: '1 minute',
    },
} as const;
