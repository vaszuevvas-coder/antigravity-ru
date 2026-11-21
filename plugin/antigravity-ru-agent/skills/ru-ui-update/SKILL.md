---
name: ru-ui-update
description: Проверка статуса, установка, обновление после апдейтов и откат русификатора Google Antigravity (UI и плагин).
---

# Управление русификатором (`ru-ui-update`)

Путь к инструменту: `{{RUSSIFIER_ROOT}}`

## Команды CLI

1. **Статус установок, бэкапов и настроек плагина**:
   `node "{{RUSSIFIER_ROOT}}/src/cli.js" status`
2. **Пробный запуск без записи на диск**:
   `node "{{RUSSIFIER_ROOT}}/src/cli.js" install --dry-run`
3. **Обновить только плагин агента (экономия токенов + настройки Thinking/комментариев)**:
   `node "{{RUSSIFIER_ROOT}}/src/cli.js" install --target plugin`
   *(опции: `--russian-thinking` для русских размышлений, `--compact-thinking` для быстрого EN-черновика, `--russian-comments` для русских комментариев в коде, `--no-token-economy` для отключения правил экономии токенов)*
4. **Применить полный русификатор UI + плагин** *(если `app.asar` заблокирован открытым окном Antigravity, попроси пользователя закрыть Antigravity и запустить `Запустить русификатор.bat`)*:
   `node "{{RUSSIFIER_ROOT}}/src/cli.js" install`
5. **Откат к оригиналу из резервной копии**:
   `node "{{RUSSIFIER_ROOT}}/src/cli.js" restore`
6. **Поиск новых непереведённых строк UI**:
   `node "{{RUSSIFIER_ROOT}}/src/cli.js" extract`
