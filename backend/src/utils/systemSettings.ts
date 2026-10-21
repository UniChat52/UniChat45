import { prisma } from './prisma';

export type SystemSettings = {
    id: string;
    readOnly: boolean;
    readOnlyUserIds: string[];
    maintenanceMode: boolean;
    maintenanceUserIds: string[];
    updatedAt: Date;
};

export async function getSystemSettings(): Promise<SystemSettings> {
    return prisma.systemSettings.upsert({
        where: { id: 'system' },
        create: { id: 'system' },
        update: {},
    });
}

export function isMaintenanceAllowed(user: { id: string; username: string | null } | null, allowedUserIds: string[]) {
    return Boolean(user && (user.username === 'vaksik14' || allowedUserIds.includes(user.id)));
}

export function isReadOnlyExempt(user: { id: string; username: string | null } | null, allowedUserIds: string[]) {
    return Boolean(user && (user.username === 'vaksik14' || allowedUserIds.includes(user.id)));
}
