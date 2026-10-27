const config = {
  title: 'Gator Dashboard',
  tagline: 'Руководство пользователя и администратора',
  url: process.env.DOCS_URL || 'https://gatorstack.github.io',
  organizationName: 'gatorstack',
  projectName: 'gator-dashboard-docs',
  baseUrl: process.env.DOCS_BASE_URL || '/gator-dashboard-docs/',
  favicon: 'img/gator.svg',
  trailingSlash: true,
  onBrokenLinks: 'throw',
  i18n: { defaultLocale: 'ru', locales: ['ru'] },
  markdown: {
    format: 'detect',
    mermaid: true,
    hooks: { onBrokenMarkdownLinks: 'throw', onBrokenMarkdownImages: 'throw' },
  },
  themes: ['@docusaurus/theme-mermaid'],
  presets: [
    ['classic', {
      docs: { routeBasePath: '/', sidebarPath: './sidebars.js' },
      blog: false,
      theme: { customCss: './src/css/custom.css' },
    }],
  ],
  themeConfig: {
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: 'Gator · Документация',
      logo: { alt: 'Gator', src: 'img/gator.svg' },
      items: [
        { type: 'doc', docId: 'getting-started', label: 'Начало работы', position: 'left' },
        { type: 'doc', docId: 'user-guide/projects', label: 'Пользователю', position: 'left' },
        { type: 'doc', docId: 'operator-manual/installation', label: 'Администратору', position: 'left' },
        { type: 'doc', docId: 'reference/entities', label: 'Сущности', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      copyright: 'Gator Dashboard · Gator Dex · Gator Cost',
    },
    prism: { additionalLanguages: ['bash', 'json', 'yaml', 'go', 'diff', 'sql'] },
    tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
  },
};

module.exports = config;
