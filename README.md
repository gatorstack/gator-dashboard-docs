# Руководство пользователя и администратора Gator

Docusaurus-сайт для тех, кто устанавливает и использует Gator Dashboard,
управляет проектами/доступом и настраивает Gator Dex или Gator Cost.
Структура ориентирована на документацию Argo CD: понятия, первый вход,
User Guide, Operator Manual и справочник сущностей. Язык — русский.

## Запустить сайт

Нужны Node.js 20+ и npm. Обычная сборка не требует соседних репозиториев.

```sh
npm ci
npm start
```

Адрес http://localhost:3000/gator-dashboard-docs/. `npm run build` создаёт `build/`,
`npm run serve` показывает готовую сборку.

## Публикуемая документация

- `docs/index.md`, `docs/concepts.md`, `docs/getting-started.md` — обзор и начало.
- `docs/user-guide/` — вход, проекты/сервисы, квоты, IAM и расходы.
- `docs/operator-manual/` — установка Dashboard/Dex/Cost, проекты, RBAC,
  каталог, TLS, обновление, backup и устранение неполадок.
- `docs/reference/` — авторский справочник сущностей, ролей, values и аннотаций.
- `docs/faq.md` — ответы на частые вопросы.

Сайт не публикует копии исходников, ТЗ, отчёты тестирования и инструкции
разработки. Важные шаги и YAML находятся непосредственно в руководствах.
Неподключённые возможности обозначены явно.

## Обновить содержание

Следуйте AGENTS.md. Сначала проверьте контракты и реализацию в нужном компоненте,
обновите соответствующее руководство по смыслу, затем выполните:

```sh
npm run docs:sync
npm run docs:check
npm run build
git diff --check
```

Синхронизация читает рабочие деревья соседних `gator-dashboard`, `gator-dex`,
`gator-cost`, включая незакоммиченные изменения. Она обновляет только
`internal/source-snapshots/` и `sources-manifest.json`. Эти материалы используются
для сверки, не имеют маршрутов на сайте и не заменяют авторские руководства.
`internal/previous-site/` сохраняет прежний вариант как непубликуемый архив.

Для размещения в подкаталоге задайте `DOCS_URL=https://docs.example.org`
и `DOCS_BASE_URL=/gator/` перед сборкой. Сайт: https://gatorstack.github.io/gator-dashboard-docs/.
Workflow GitHub Actions публикует только build/; internal snapshots не входят в Git.
Официальные руководства: [Docusaurus](https://docusaurus.io/docs),
[Argo CD](https://argo-cd.readthedocs.io/en/stable/).
