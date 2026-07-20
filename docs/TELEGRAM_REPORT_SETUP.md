# Настройка отправки отчёта по качеству в Telegram (ОК)

Ежедневный / еженедельный отчёт по контролю качества бухгалтерских услуг
отправляется в Telegram-группу ОК Edge-функцией `quality-report-telegram`.

## Что уже готово в коде

- `supabase/functions/quality-report-telegram/index.ts` — собирает отчёт
  (по отделу + по каждому бухгалтеру, блок «ОЧЕНЬ СРОЧНО», похвалы, работа Соны)
  и постит его через Telegram Bot API.
- `supabase/migrations/0031_schedule_quality_report_telegram.sql` — расписание
  через `pg_cron` + `pg_net` (Пн–Пт 19:30 и Пн 09:30 по Еревану). Миграция
  безопасна: пока не заданы настройки ниже, она ничего не планирует.
- Текст сообщения совпадает с предпросмотром на странице «Отчёты → Отдел».

## Шаги развёртывания (однократно)

1. **Создать бота** у @BotFather, получить `TELEGRAM_BOT_TOKEN`.
   Добавить бота в группу ОК и узнать `chat_id` группы (например через
   `https://api.telegram.org/bot<TOKEN>/getUpdates` после сообщения в группе).

2. **Задать секреты функции** (не коммитятся, только в Supabase):
   ```bash
   supabase secrets set TELEGRAM_BOT_TOKEN=123456:AA... TELEGRAM_CHAT_ID=-1001234567890
   ```

3. **Развернуть функцию**:
   ```bash
   supabase functions deploy quality-report-telegram --project-ref fjsogozwseqoxgddjeig
   ```

4. **Проверить вручную** (должно прийти сообщение в группу):
   ```bash
   curl -X POST "https://fjsogozwseqoxgddjeig.supabase.co/functions/v1/quality-report-telegram?period=daily" \
     -H "Authorization: Bearer <SERVICE_ROLE_OR_FUNCTION_KEY>"
   ```

5. **Включить расписание** — задать настройки БД и применить `0031`:
   ```sql
   alter database postgres set app.edge_base_url = 'https://fjsogozwseqoxgddjeig.supabase.co/functions/v1';
   alter database postgres set app.edge_auth     = 'Bearer <SERVICE_ROLE_OR_FUNCTION_KEY>';
   ```
   затем повторно выполнить миграцию `0031` (или её `do`-блок). После этого cron
   отправит отчёт ежедневно (Пн–Пт 19:30) и еженедельно (Пн 09:30) по Еревану.

## Расписание

| Что | Cron (UTC) | По Еревану (UTC+4) |
|-----|-----------|--------------------|
| Ежедневный отчёт | `0 16 * * *` | каждый день 20:00 |
| Еженедельный отчёт | `30 5 * * 1` | Пн 09:30 |

Время можно изменить в `0031`. Токен и `chat_id` — только в секретах Supabase,
никогда в git.
