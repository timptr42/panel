# timptr panel

Мини-панель управления Ubuntu-сервером для Docker, nginx и certbot.

Приложение рассчитано на работу по адресу `https://panel.timptr.ru`, внутри Docker-контейнера слушает порт `7777`.

## Возможности

- вход по одному паролю;
- просмотр всех Docker-контейнеров, их статусов и опубликованных портов;
- `start` / `stop` / `restart` Docker-контейнеров;
- просмотр nginx-конфигов из `/etc/nginx/sites-available` и активных правил из `/etc/nginx/sites-enabled`;
- создание и изменение маршрутов вида `%project%.timptr.ru -> http://127.0.0.1:%port%`;
- просмотр сертификатов Let's Encrypt через `certbot certificates`;
- выпуск/переустановка сертификата через `certbot --nginx`.
- отображение версии и build id в title и интерфейсе.

## Требования к серверу

- Ubuntu;
- Docker и Docker Compose plugin;
- nginx как host-сервис;
- certbot с nginx-плагином;
- DNS `panel.timptr.ru` и проектных доменов должен указывать на сервер.

Панель запускается как привилегированный контейнер и получает доступ к host namespace через `nsenter`. Это нужно, чтобы управлять Docker, nginx и certbot на самом сервере.

## Быстрая установка на сервер

```bash
git clone https://github.com/timptr42/panel.git /opt/panel
cd /opt/panel
sudo bash scripts/install.sh
```

Скрипт:

1. проверит наличие Docker/nginx/certbot;
2. создаст `.env`, если его еще нет;
3. запросит мастер-пароль панели в диалоговом режиме;
4. сгенерирует `SESSION_SECRET` для подписи cookie-сессии;
5. соберет и запустит контейнер панели на `127.0.0.1:7777`;
6. создаст nginx-маршрут `panel.timptr.ru -> 127.0.0.1:7777`;
7. выполнит `nginx -t` и `systemctl reload nginx`.

Build id берется из текущего git commit и отображается в title страницы, например `timptr panel v1.0.0 (abc1234)`.

После этого зайдите на `http://panel.timptr.ru`, авторизуйтесь мастер-паролем и при необходимости выпустите HTTPS-сертификат для `panel.timptr.ru` через UI. Для выпуска сертификата панель запросит email.

`SESSION_SECRET` нужен Express для подписи cookie-сессии. Он не является паролем входа, но должен быть стабильным между рестартами: иначе все сессии будут сбрасываться. Слабый или общий секрет также упрощает подделку session cookie, поэтому install-скрипт генерирует длинное случайное значение автоматически.

## Ручной запуск без install.sh

```bash
cp .env.example .env
nano .env
docker compose up -d --build
```

Host nginx route для панели:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name panel.timptr.ru;

    location / {
        proxy_pass http://127.0.0.1:7777;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## Настройки окружения

| Переменная | Значение по умолчанию | Описание |
| --- | --- | --- |
| `PORT` | `7777` | Порт внутри контейнера |
| `PANEL_PASSWORD_B64` | - | Пароль администратора в base64; installer заполняет автоматически |
| `PANEL_PASSWORD` | - | Legacy-вариант пароля администратора, используется только если нет `PANEL_PASSWORD_B64` |
| `SESSION_SECRET` | - | Секрет cookie-сессии |
| `COOKIE_SECURE` | `false` | Оставьте `false` для HTTP. Поставьте `true` только после выпуска HTTPS-сертификата |
| `TRUST_PROXY` | `true` | Доверять `X-Forwarded-Proto` от nginx, чтобы secure-cookie работали за reverse proxy |
| `PANEL_BUILD` | git commit | Build id, который показывается в title и UI |
| `PANEL_VERSION` | package version | Версия приложения, которую показывает title и UI |
| `HOST_ROOT` | `/host` | Mount host root внутри контейнера |
| `HOST_COMMAND_MODE` | `nsenter` | `nsenter` для контейнера, `direct` для локальной разработки |
| `NGINX_MANAGED_PREFIX` | `panel-managed-` | Префикс nginx-конфигов, которые создает панель |
| `ALLOW_ANY_DOMAIN` | `false` | По умолчанию разрешены только `*.timptr.ru` |

## Как создаются маршруты

Для домена `einstein.timptr.ru` и порта `40000` панель создает файл:

```text
/etc/nginx/sites-available/panel-managed-einstein.timptr.ru.conf
```

и symlink:

```text
/etc/nginx/sites-enabled/panel-managed-einstein.timptr.ru.conf
```

Перед перезагрузкой nginx всегда выполняется `nginx -t`.

## Если открывается 502 Bad Gateway

502 от nginx означает, что домен ведет на сервер, но приложение панели на `127.0.0.1:7777` не отвечает.

Проверьте:

```bash
cd /opt/panel
sudo docker compose ps
sudo docker compose logs --tail=120 panel
sudo ss -ltnp | grep 7777
```

Повторная установка/перезапуск:

```bash
cd /opt/panel
sudo git pull origin main
sudo bash scripts/install.sh
```

Install-скрипт сам ожидает healthcheck контейнера и покажет последние логи, если панель не стартовала.

Если `docker compose` сообщает `failed to read /opt/panel/.env`, удалите поврежденные строки и запустите installer еще раз:

```bash
cd /opt/panel
sudo sed -i '/^[A-Za-z_][A-Za-z0-9_]*=/!d' .env
sudo bash scripts/install.sh
```

Чтобы сбросить пароль панели:

```bash
cd /opt/panel
sudo sed -i '/^PANEL_PASSWORD=/d' .env
sudo sed -i '/^PANEL_PASSWORD_B64=/d' .env
sudo bash scripts/install.sh
```

Installer хранит пароль в `.env` как `PANEL_PASSWORD_B64=...`, поэтому пароль может содержать любые символы кроме перевода строки.

## Локальная проверка

```bash
npm install
PANEL_PASSWORD=dev SESSION_SECRET=dev HOST_COMMAND_MODE=direct npm start
```

Для полноценной работы локально нужны `docker`, `nginx` и `certbot` в окружении запуска.
