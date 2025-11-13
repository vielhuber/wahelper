# 🍸 wahelper 🍸

wahelper is a lightweight whatsapp integration layer built on top of [baileys](https://github.com/WhiskeySockets/Baileys) that provides a simple cli, php wrapper, and mcp server for fetching messages, sending direct and group messages, and wiring whatsapp into existing tooling (wordpress, node, mcp clients) without having to deal with the full session lifecycle yourself.

## installation

### initial clone (into current project)

```sh
git subtree add \
    --prefix path/to/subfolder/wahelper \
    git@github.com:vielhuber/wahelper.git \
    main \
    --squash
```

### update library

```sh
git subtree pull \
    --prefix path/to/subfolder/wahelper \
    git@github.com:vielhuber/wahelper.git \
    main \
    --squash
```

### push to library (if you have permissions)

```sh
git subtree push \
    --prefix path/to/subfolder/wahelper \
    git@github.com:vielhuber/wahelper.git \
    main
```

### install dependencies

```sh
nvm use --lts
npm install
```

### setup .env

```sh
cp .env.example .env
vi .env
```

## usage

### cli

```sh
node whatsapp.js --action "fetch_messages"

node whatsapp.js --action "send_user" \
    --number "xxxxxxxxxxxx" \
    --message "This is a test! 🚀"

node whatsapp.js --action "send_group" \
    --name "Group name" \
    --message "This is a test! 🚀"

node whatsapp.js --action "send_user" \
    --number "xxxxxxxxxxxx" \
    --message "This is a test! 🚀" \
    --attachments="/full/path/to/file.pdf,/full/path/to/image.png"

node
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
    'action' => 'fetch_messages'
]);

// send messages
WhatsApp::run([
    'action' => 'send_user',
    'number' => 'xxxxxxxxxxxx',
    'message' => 'This is a test! 🚀'
]);
WhatsApp::run([
    'action' => 'send_group',
    'name' => 'Group name',
    'message' => 'This is a test! 🚀'
]);

// send attachments
WhatsApp::run([
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
            "command": "node",
            "args": ["/var/www/project/path/to/subfolder/wahelper/whatsapp.js", "--mcp"]
        }
    }
}
```
