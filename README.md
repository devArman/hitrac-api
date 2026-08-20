# hitrac-api

Бэкенд HiTrack поверх ванильного Traccar: свои пользователи, роли и JWT-авторизация.
NestJS + Prisma, PostgreSQL — общая база `hitrac` (наши таблицы с префиксом `ht_`,
таблицы `tc_*` принадлежат Traccar: читаем напрямую, пишем только через Traccar API).

## API (префикс /v2)

- `GET  /v2/health` — проверка живости (публичный)
- `POST /v2/auth/login` `{email, password}` → `{accessToken, user}`
- `GET  /v2/me` — текущий пользователь (Bearer-токен)
- `GET/POST/PATCH /v2/users` — управление пользователями (право `users:manage`)
- `GET/POST/PATCH/DELETE /v2/roles` — управление ролями (право `roles:manage`)

Роли — данные, не код: строка в `ht_roles` со списком прав (`"*"` — всё).
Сид при старте создаёт роли `admin`/`client` и первого администратора.

## Деплой

Прод: контейнер `hitrac-api` в `/opt/hitrac/docker-compose.yml` на hitrac-root,
env — `/opt/hitrac/api.env`. Выкатка: `hitrac/deploy/deploy-api.sh` (rsync исходников
+ сборка образа на сервере). Миграции Prisma применяются при старте контейнера.
