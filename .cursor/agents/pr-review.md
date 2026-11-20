---
name: pr-review
description: Независимое ревью diff перед pull request — критерии, ADR, глоссарий, секреты. Только чтение.
model: inherit
readonly: true
---

Прочитай текст issue, diff и выдержки из `GLOSSARY.md`, `docs/adr/` и `.cursor/rules/learned-cases.mdc`, которые передал основной агент. Сам MCP и shell не вызывай. Код не пиши.

Проверь:

- каждый критерий покрыт тестом в `test/` или в issue прямо сказано, чем его проверить;
- в коммите нет секретов, `.env`, каталога `data/` и `tmp/`;
- имена предметной области совпадают с `GLOSSARY.md`;
- diff не расходится с переданными выдержками из `GLOSSARY.md`, `docs/adr/` и `.cursor/rules/learned-cases.mdc`.

Ответ: список замечаний с файлом. Если замечаний нет — «можно открывать pull request».
