module.exports = {
  documentation: [
    'index',
    'concepts',
    'getting-started',
    { type: 'category', label: 'Руководство пользователя', collapsed: false, items: [
      'user-guide/login', 'user-guide/projects', 'user-guide/quotas',
      'user-guide/iam', 'user-guide/costs',
    ] },
    { type: 'category', label: 'Руководство администратора', items: [
      'operator-manual/installation', 'operator-manual/dex',
      'operator-manual/projects', 'operator-manual/rbac',
      'operator-manual/product-packages', 'operator-manual/catalog', 'operator-manual/resource-pages', 'operator-manual/resource-actions', 'operator-manual/iaas', 'operator-manual/vpc',
      'operator-manual/ingress-tls', 'operator-manual/billing-installation',
      'operator-manual/billing-configuration', 'operator-manual/upgrading',
      'operator-manual/backup', 'operator-manual/troubleshooting',
    ] },
    { type: 'category', label: 'Справочник', items: [
      'reference/entities', 'reference/roles', 'reference/helm-values',
      'reference/annotations', 'reference/resource-map', 'reference/billing-binding',
    ] },
    'faq',
  ],
};
