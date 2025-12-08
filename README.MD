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

### cli

```sh
npx wahelper \
    --disable-warning=ExperimentalWarning \
    --device "xxxxxxxxxxxx" \
    ...

    --action "fetch_messages" \
    --limit 42

    --action "send_user" \
    --number "xxxxxxxxxxxx" \
    --message "This is a test! 🚀"

    --action "send_group" \
    --name "Group name" \
    --message "This is a test! 🚀"

    --action "send_user" \
    --number "xxxxxxxxxxxx" \
    --message "This is a test! 🚀" \
    --attachments "/full/path/to/file.pdf,/full/path/to/image.png"

sqlite3 \
    -header \
    -column \
    whatsapp.sqlite \
    "SELECT text FROM messages ORDER BY timestamp ASC" | \
    tail -10
```

### php

```php
require_once __DIR__ . '/vendor/autoload.php';
use vielhuber\wahelper\wahelper;

$wahelper = new wahelper();

// fetch messages
$wahelper->fetchMessages(
    device: 'xxxxxxxxxxxx',
    limit: 42
);

// send message to user
$wahelper->sendUser(
    device: 'xxxxxxxxxxxx',
    number: 'xxxxxxxxxxxx',
    message => 'This is a test! 🚀',
    attachments: ['/full/path/to/file.pdf', '/full/path/to/image.png']
]);

// send message to group
$wahelper->sendGroup(
    device: 'xxxxxxxxxxxx',
    name: 'Group name',
    message: 'This is a test! 🚀',
    attachments: ['/full/path/to/file.pdf', '/full/path/to/image.png']
]);
```

### mcp

```json
{
    "mcpServers": {
        "whatsapp": {
            "command": "/root/.nvm/versions/node/v22.20.0/bin/node",
            "args": ["/var/www/project/node_modules/@vielhuber/wahelper/mcp.js"]
        }
    }
}
```
