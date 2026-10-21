import Redis from 'ioredis';
import { config } from '../config';

export const redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
});

redis.on('error', (err) => {
    console.error('Redis connection error:', err.message);
});

redis.on('connect', () => {
    console.log('✅ Redis connected');
});
