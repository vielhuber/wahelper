[![build status](https://github.com/vielhuber/wahelper/actions/workflows/ci.yml/badge.svg)](https://github.com/vielhuber/wahelper/actions)
[![GitHub Tag](https://img.shields.io/github/v/tag/vielhuber/wahelper)](https://github.com/vielhuber/wahelper/tags)
[![Code Style](https://img.shields.io/badge/code_style-psr--12-ff69b4.svg)](https://www.php-fig.org/psr/psr-12/)
[![License](https://img.shields.io/github/license/vielhuber/wahelper)](https://github.com/vielhuber/wahelper/blob/main/LICENSE.md)
[![Last Commit](https://img.shields.io/github/last-commit/vielhuber/wahelper)](https://github.com/vielhuber/wahelper/commits)
[![PHP Version Support](https://img.shields.io/packagist/php-v/vielhuber/wahelper)](https://packagist.org/packages/vielhuber/wahelper)
[![Packagist Downloads](https://img.shields.io/packagist/dt/vielhuber/wahelper)](https://packagist.org/packages/vielhuber/wahelper)
[![node version](https://img.shields.io/node/v/@vielhuber/wahelper)](https://www.npmjs.com/package/@vielhuber/wahelper)
[![npm Version](https://img.shields.io/npm/v/@vielhuber/wahelper)](https://www.npmjs.com/package/@vielhuber/wahelper)
[![npm Downloads](https://img.shields.io/npm/dt/@vielhuber/wahelper)](https://www.npmjs.com/package/@vielhuber/wahelper)

# 🍸 wahelper 🍸

wahelper is a lightweight whatsapp integration layer built on top of [baileys](https://github.com/WhiskeySockets/Baileys) that provides a simple cli, php wrapper, and mcp server for fetching messages, sending direct and group messages, and wiring whatsapp into existing tooling (wordpress, node, mcp clients) without having to deal with the full session lifecycle yourself.

## requirements

- node >= 22
- php >= 8.1

## installation

### js

```sh
npm install @vielhuber/wahelper
```

### php

```sh
composer require vielhuber/wahelper
```

### .gitignore

```
/whatsapp_data/
```

## usage

### start daemon

```sh
npx wahelper-daemon --device "xxxxxxxxxxxx"
```

### cli

```sh
npx wahelper \
    --device "xxxxxxxxxxxx" \
    ...

    # fetch messages
    --action "fetch_messages" \
    --filter '{"from":"491234567890","to":"491234567890","message":"meeting","date_from":"2026-01-01","date_until":"2026-12-31"}' \
    --limit 42 \
    --order "desc"

    # view a single message by id
    --action "view_message" \
    --id "ABCDEF1234567890"

    # send message to user
    --action "send_user" \
    --number "xxxxxxxxxxxx" \
    --message "This is a test! 🚀" \
    --attachments "/full/path/to/file.pdf,/full/path/to/image.png"

    # send message to group
    --action "send_group" \
    --name "Group name" \
    --message "This is a test! 🚀" \
    --attachments "/full/path/to/file.pdf,/full/path/to/image.png"
```

### php

```php
require_once __DIR__ . '/vendor/autoload.php';
use vielhuber\wahelper\wahelper;

$wahelper = new wahelper();

// fetch messages
$wahelper->fetchMessages(
    device: 'xxxxxxxxxxxx',
    filter: [
        'from' => '491234567890',
        'to' => '491234567890',
        'message' => 'meeting',
        'date_from' => '2026-01-01',
        'date_until' => '2026-12-31'
    ],
    limit: 42,
    order: 'desc'
);

// view a single message by id
$wahelper->viewMessage(
    device: 'xxxxxxxxxxxx',
    id: 'ABCDEF1234567890'
);

// send message to user
$wahelper->sendUser(
    device: 'xxxxxxxxxxxx',
    number: 'xxxxxxxxxxxx',
    message: 'This is a test! 🚀',
    attachments: ['/full/path/to/file.pdf', '/full/path/to/image.png']
);

// send message to group
$wahelper->sendGroup(
    device: 'xxxxxxxxxxxx',
    name: 'Group name',
    message: 'This is a test! 🚀',
    attachments: ['/full/path/to/file.pdf', '/full/path/to/image.png']
);
```

### mcp

```json
{
    "mcpServers": {
        "whatsapp": {
            "command": "/usr/bin/php8.1",
            "args": ["/var/www/wahelper/vendor/bin/mcp-server.php"]
        }
    }
}
```

## daemon

```sh
# install pm2
npm install -g pm2

# start daemon (linux)
pm2 start npx --name wahelper-xxxxxxxxxxxx --cwd /var/www/wahelper -- wahelper-daemon --device xxxxxxxxxxxx

# start daemon (windows)
pm2 start node --name wahelper-xxxxxxxxxxxx --cwd "C:\path\to\project" -- node_modules/@vielhuber/wahelper/wahelper-daemon.js --device xxxxxxxxxxxx

## autostart (linux)
pm2 save
pm2 startup

## autostart (windows)
pm2 save
Windows Task Scheduler > Create Task > Triggers: At startup → Actions: Start a program → Program: "C:\Users\<user>\AppData\Roaming\npm\pm2.cmd", Arguments: "resurrect"

# more commands
pm2 unstartup                      # remove autostart
pm2 status                         # show status of all processes
pm2 resurrect                      # restore saved process list
pm2 save                           # save current process list for resurrect
pm2 start wahelper-xxxxxxxxxxxx    # start a stopped process
pm2 stop wahelper-xxxxxxxxxxxx     # stop a running process
pm2 restart wahelper-xxxxxxxxxxxx  # restart a process
pm2 logs wahelper-xxxxxxxxxxxx     # tail live logs
pm2 delete wahelper-xxxxxxxxxxxx   # remove process
```
