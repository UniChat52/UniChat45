# UniChat

Production-grade web messenger. Приватные и групповые чаты, файлы, голосовые сообщения, i18n (RU/EN).

## Стек

- **Backend**: Node.js 20 + TypeScript + Fastify + Prisma + Socket.IO
- **Frontend**: React 18 + TypeScript + Vite + Zustand
- **Database**: PostgreSQL 16
- **Cache**: Redis 7
- **Files**: MinIO (S3-compatible)
- **Proxy**: Nginx
- **Containers**: Docker + docker-compose

## Быстрый старт

```bash
# 1. Скопировать .env
cp .env.example .env

# 2. Запустить все сервисы
docker-compose up --build

# 3. Открыть в браузере
http://localhost
```

## Структура проекта

```
├── backend/         # API + WebSocket сервер
├── frontend/        # React SPA
├── nginx/           # Reverse proxy конфиг
├── docker-compose.yml
└── .env.example
```

## Лицензия

Proprietary. All rights reserved.

---

> ⚠️ **Юридическое замечание**: Для production-деплоя в РФ необходима консультация юриста
> по вопросам обработки персональных данных (152-ФЗ), политики конфиденциальности
> и пользовательского соглашения.
