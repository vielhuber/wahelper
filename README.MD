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

## usage

### cli

```sh
npx wahelper --device="xxxxxxxxxxxx" --action "fetch_messages"

npx wahelper --device="xxxxxxxxxxxx" --action "send_user" \
    --number "xxxxxxxxxxxx" \
    --message "This is a test! 🚀"

npx wahelper --device="xxxxxxxxxxxx" --action "send_group" \
    --name "Group name" \
    --message "This is a test! 🚀"

npx wahelper --device="xxxxxxxxxxxx" --action "send_user" \
    --number "xxxxxxxxxxxx" \
    --message "This is a test! 🚀" \
    --attachments="/full/path/to/file.pdf,/full/path/to/image.png"

npx wahelper
    --disable-warning=ExperimentalWarning
    ...

sqlite3 \
    -header \
    -column \
    whatsapp.sqlite \
    "SELECT text FROM messages ORDER BY timestamp ASC" | \
    tail -10
```

### php

```php
require_once 'whatsapp.php';

// fetch messages
WhatsApp::run([
    'device' => 'xxxxxxxxxxxx',
    'action' => 'fetch_messages'
]);

// send messages
WhatsApp::run([
    'device' => 'xxxxxxxxxxxx',
    'action' => 'send_user',
    'number' => 'xxxxxxxxxxxx',
    'message' => 'This is a test! 🚀'
]);
WhatsApp::run([
    'device' => 'xxxxxxxxxxxx',
    'action' => 'send_group',
    'name' => 'Group name',
    'message' => 'This is a test! 🚀'
]);

// send attachments
WhatsApp::run([
    'device' => 'xxxxxxxxxxxx',
    'action' => 'send_user', // or 'send_group'
    /* ... */
    'attachments' => ['/full/path/to/file.pdf', '/full/path/to/image.png']
]);
```

### mcp

```
{
    "mcpServers": {
        "whatsapp": {
            "command": "/root/.nvm/versions/node/v22.20.0/bin/node",
            "args": ["/var/www/project/node_modules/@vielhuber/wahelper/whatsapp.js", "--mcp"]
        }
    }
}
```
