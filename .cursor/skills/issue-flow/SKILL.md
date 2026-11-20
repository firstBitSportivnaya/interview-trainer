---
name: issue-flow
description: Ведёт доработку этого репозитория по GitHub issue — ветка от master, код, тесты node:test, проверки, коммит, push и pull request, затем стоп. Use when the user gives an issue number or link, says «сделай issue», «возьми issue», «проверь реализацию issue» или просит разобрать замечания к pull request.
---

# Доработка по issue

Порядок действий — `AGENTS.md`. Процесс и проверки — `docs/workflow.md`. Репозиторий и инструменты GitHub — `docs/agents/issue-tracker.md`. Этот skill добавляет только то, что относится к Cursor.

## GitHub в Cursor

Через MCP `user-GitKraken`. Перед первым вызовом инструмента — `GetDynamicTools` для него.

| Шаг `AGENTS.md` | Инструмент |
|---|---|
| Прочитать issue | `issues_get_detail` |
| Создать pull request | `pull_request_create` |
| Статус и замечания ревью | `pull_request_get_detail`, `pull_request_get_comments` |
| Комментарий в issue | `issues_add_comment` |

Коммит, push и ветки — `git` в shell. Цель pull request — `master`.

## Карта приёмки

Перед кодом выписать по каждому критерию: формулировка, файл теста в `test/` или названная проверка, негативный случай. Эту же карту перенести в таблицу pull request.

## Тело pull request

Текст уходит в `pull_request_create` целиком. На длинном тексте вызов падает с `MCP error -32603` без указания поля. Один вызов — до 3000 знаков.

- Сразу собирать тело по `.github/pull_request_template.md`: таблицы, фактический вывод проверок, без пересказа файлов.
- Тело созданного pull request этим инструментом не правится. Карта приёмки и вывод проверок должны попасть в первый вызов.
- Что не влезло — комментарий `issues_add_comment` с заголовком «Подробности проверок». Номер в вызове — номер pull request: у GitHub общая нумерация.

## Сбой создания

Если `-32603` пришёл на длинном тексте — сократить его. Список `issues_assigned_to_me` для поиска дубля не использовать.

1. Перед вызовом запомнить наибольший номер, который уже встречался. Нумерация issue и pull request общая.
2. После ошибки — `issues_get_detail` по номерам выше него, пока не найдётся объект с тем же заголовком или не вернётся «не найдено». Для pull request сверить ветку через `pull_request_get_detail`.
3. Нашли — вызов не повторять. Не нашли — один повтор.

## Субагенты

`spec-check` и `pr-review` сами MCP и shell не вызывают. Основной агент передаёт `spec-check` текст issue, а `pr-review` — текст issue, вывод `git diff origin/master...HEAD` и выдержки из `GLOSSARY.md`, `docs/adr/` и `.cursor/rules/learned-cases.mdc`, которые относятся к этому diff.

## Ответ на ревью

Комментарии читать через `pull_request_get_comments`. Каждый — исправить или ответить отказом со ссылкой на ADR, глоссарий или правило.

## Вопросы человеку

Через `AskQuestion`, только в случаях из шага 1 `AGENTS.md`.

## Проверка чужой реализации

Если просят проверить готовый pull request или ветку: прочитать issue и diff (`git fetch`, `git diff origin/master...<ветка>`). Сопоставить каждый критерий с тестом в `test/` или с названной проверкой. Прогнать `npm run verify` без правок кода. Отчёт — по критериям: покрыт и проходит, не покрыт или падает, с выводом команды.
