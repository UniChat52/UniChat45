# UniChat

Исходный код UniChat: React + Vite frontend, Fastify + Prisma backend, PostgreSQL, Redis, MinIO и Nginx.

## Запуск

Требуются Docker Engine и Docker Compose.

```bash
cp .env.example .env
docker compose up --build
```

После запуска откройте `http://localhost`. Для остановки нажмите `Ctrl+C`; контейнеры можно остановить командой `docker compose down`.

Шаблон `.env.example` содержит только dev-настройки. Перед публикацией или production-запуском замените JWT-ключи, пароли БД и MinIO, а также задайте параметры Twilio.

## Структура

- `backend/` — API, Socket.IO и схема Prisma.
- `frontend/` — React-приложение.
- `nginx/` — конфигурация обратного прокси.
- `docker-compose.yml` — сервисы приложения.

`node_modules`, собранные `dist`, локальный `.env` и Git-история не включены. Зависимости устанавливаются Docker при сборке. Для ручного запуска используйте Node.js 20 и `npm ci` в `backend/` и `frontend/`.
