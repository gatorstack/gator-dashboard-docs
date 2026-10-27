# Ingress и TLS

У решения два разных контура TLS: внешний HTTPS для браузера и внутренний TLS
admission webhook. Сертификат Ingress не заменяет сертификат webhook.

## HTTPS консоли

Внешний Ingress настраивается в values:

```yaml
cookieSecure: true
ingress:
  enabled: true
  className: nginx
  host: dashboard.example.org
  tls:
    - secretName: dashboard-tls
      hosts: [dashboard.example.org]
```

Secret `dashboard-tls` должен существовать в namespace Dashboard и содержать
`tls.crt` и `tls.key`. DNS-имя направляется на ваш Ingress controller.

Для автоматического выпуска cert-manager добавьте аннотацию вашего ClusterIssuer:

```yaml
ingress:
  annotations:
    cert-manager.io/cluster-issuer: your-cluster-issuer
```

Замените имя существующим issuer. Отдельно проверьте его Ready и успешный выпуск
Certificate. Сертификаты Dex настраиваются аналогично в его namespace.

## Внутренний webhook

| Режим | Настройка | Продление |
| --- | --- | --- |
| Helm | `webhook.certManager.enabled: false`, без existingSecret | Сертификат на 365 дней; автоматического продления нет |
| cert-manager | `webhook.certManager.enabled: true` | Leaf-сертификат обновляется автоматически |
| Внешний Secret | `webhook.tls.existingSecret` и `webhook.tls.caBundle` | Ответственность администратора |

В режиме cert-manager chart создаёт внутренние CA/Issuer/Certificate.
Сервер перечитывает сертификат при новых TLS-соединениях. Корневой CA имеет
отдельный срок и план ротации; продление leaf не заменяет ротацию CA.

Для внешнего сертификата Secret содержит `tls.crt` и `tls.key`, а `caBundle`
содержит CA в base64. При замене внешнего сертификата запланируйте перезапуск Pod
и проверку создания/обновления Project.

## Cookie и локальный доступ

При `cookieSecure: true` браузер отправляет сессионную cookie только по HTTPS.
Поэтому HTTP port-forward сам по себе не является рабочей заменой HTTPS-входа.
Для временного изолированного локального HTTP-просмотра нужна отдельная установка
с `cookieSecure: false`; не переносите это значение в публичную конфигурацию.

## Прокси и watch

Прокси должен передавать потоковые ответы без буферизации. Для nginx Ingress
при необходимости настройте аннотации в вашей конфигурации:

```yaml
ingress:
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
```

После изменения проверьте, что обновления объектов видны без ручной перезагрузки.
