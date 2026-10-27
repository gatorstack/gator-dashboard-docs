import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const sources = [
  { key: 'dashboard', repo: 'gator-dashboard', entries: ['README.md', 'docs', 'backend/README.md', 'frontend/README.md', 'charts/gator-dashboard/README.md', 'example', 'charts/gator-dashboard/values.yaml', 'charts/gator-dashboard/crds', 'charts/gator-dashboard/templates/standard-roles.yaml', 'charts/gator-dashboard/templates/role-catalog.yaml', 'charts/gator-dashboard/templates/iam-password-role.yaml', 'charts/gator-dashboard/templates/authentificated-rbac.yaml'] },
  { key: 'dex', repo: 'gator-dex', entries: ['docs/gator', 'examples/gator/config.yaml', 'examples/gator/users-groups.yaml'] },
  { key: 'cost', repo: 'gator-cost', entries: ['README.md', 'docs', 'examples/openmeter', 'examples/proposed', 'patches/openmeter/invoice-simulation-engine.patch'] },
];
const expected = new Map();
const manifest = { format: 1, sources: [] };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const slash = (value) => value.split(path.sep).join('/');
const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap((entry) => {
  const file = path.join(dir, entry.name);
  if (entry.isSymbolicLink() || entry.name.startsWith('.')) return [];
  return entry.isDirectory() ? filesIn(file) : [file];
});
const extensions = new Set(['.md', '.yaml', '.yml', '.json', '.patch']);

for (const source of sources) {
  const repo = path.resolve(root, '..', source.repo);
  if (!existsSync(repo)) throw new Error(`Нет ${repo}. Разместите исходный репозиторий рядом; для обычной сборки синхронизация не нужна.`);
  const files = [...new Set(source.entries.flatMap((entry) => {
    const file = path.join(repo, entry);
    if (!existsSync(file)) throw new Error(`Не найден обязательный источник ${source.repo}/${entry}`);
    return statSync(file).isDirectory() ? filesIn(file) : [file];
  }))].filter((file) => extensions.has(path.extname(file))).sort();
  const output = (file) => `internal/source-snapshots/${source.key}/${slash(path.relative(repo, file))}${file.endsWith('.md') ? '' : '.md'}`;
  const exported = new Map(files.map((file) => [file, output(file)]));
  const sourceManifest = { repository: source.repo, files: [] };

  for (const file of files) {
    const relative = slash(path.relative(repo, file));
    if (!realpathSync(file).startsWith(realpathSync(repo) + path.sep) || /(^|\/)(private|node_modules|\.git)(\/|$)/.test(relative)) throw new Error(`Недопустимый источник: ${relative}`);
    const original = readFileSync(file, 'utf8');
    if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:postgres(?:ql)?:\/\/)[^\s:@]+:[^\s@]+@/.test(original)) throw new Error(`Проверьте секретные данные в ${source.repo}/${relative}; экспорт остановлен.`);
    const target = output(file);
    const historical = /-v0\.1\.md$|verification-initial\.md$|opencost\.md$|\/proposed\//.test(relative) && source.key === 'cost';
    const note = historical
      ? '**Архив версии 0.1.** Текущий биллинг описан в руководстве «Биллинг»: версия 0.2 использует OpenMeter и начатые минуты.'
      : '**Справочный снимок исходного репозитория.** Даты проверок и состояние окружения относятся к моменту, указанному в документе. Шаблоны с `[Заполнить]` не являются реализованными возможностями.';
    const banner = `> ${note}\n> Источник: \`${source.repo}/${relative}\`. Обновляется командой \`npm run docs:sync\`; правки вносите в исходный файл.\n\n`;
    let content;
    if (file.endsWith('.md')) {
      content = original.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, label, link) => {
        if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(link)) return match;
        const [destination, fragment] = link.split('#');
        const resolved = path.resolve(path.dirname(file), decodeURI(destination));
        if (exported.has(resolved)) {
          let mapped = slash(path.relative(path.dirname(target), exported.get(resolved)));
          if (!mapped.startsWith('.')) mapped = `./${mapped}`;
          return `[${label}](${mapped}${fragment ? `#${fragment}` : ''})`;
        }
        if (existsSync(resolved) && statSync(resolved).isDirectory()) {
          const children = files.filter((item) => item.startsWith(resolved + path.sep));
          if (children.length) {
            const index = `internal/source-snapshots/${source.key}/${slash(path.relative(repo, resolved))}/file-list.md`;
            const links = children.map((item) => `- [${slash(path.relative(resolved, item))}](./${slash(path.relative(path.dirname(index), exported.get(item)))})`).join('\n');
            expected.set(index, `# ${source.repo}/${slash(path.relative(repo, resolved))}\n\n${banner}${links}\n`);
            return `[${label}](${slash(path.relative(path.dirname(target), index))})`;
          }
        }
        throw new Error(`Неэкспортированная локальная ссылка: ${source.repo}/${relative} -> ${link}`);
      });
      // Leave front matter first and keep the original heading anchors.
      const front = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
      const offset = front ? front[0].length : 0;
      const heading = content.slice(offset).match(/^# .+\r?\n/);
      const insertion = offset + (heading ? heading[0].length : 0);
      content = `${content.slice(0, insertion)}\n${banner}${content.slice(insertion).trimStart()}`;
    } else {
      const language = { '.yaml': 'yaml', '.yml': 'yaml', '.json': 'json', '.patch': 'diff' }[path.extname(file)];
      content = `# ${relative}\n\n${banner}\`\`\`${language}\n${original.trimEnd()}\n\`\`\`\n`;
    }
    expected.set(target, content);
    sourceManifest.files.push({ path: relative, sha256: hash(original), document: target });
  }
  manifest.sources.push(sourceManifest);
}
expected.set('sources-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
const generated = path.join(root, 'internal/source-snapshots');
const current = existsSync(generated) ? filesIn(generated).map((file) => slash(path.relative(root, file))) : [];
const stale = current.filter((file) => !expected.has(file));
const changed = [...expected].filter(([file, content]) => !existsSync(path.join(root, file)) || readFileSync(path.join(root, file), 'utf8') !== content);
if (check) {
  if (changed.length || stale.length) {
    console.error(`Справочник отстал: ${changed.length} новых/изменённых файлов, ${stale.length} удалённых. Запустите npm run docs:sync.`);
    process.exitCode = 1;
  } else console.log(`Справочник актуален: ${expected.size - 1} страниц, ${manifest.sources.length} репозитория.`);
} else {
  for (const file of stale) rmSync(path.join(root, file));
  for (const [file, content] of changed) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  console.log(`Синхронизировано ${expected.size - 1} страниц из ${manifest.sources.length} репозиториев (${changed.length} файлов обновлено).`);
}
