# 🍸 wahelper 🍸

wahelper is a lightweight whatsapp integration layer built on top of [baileys](https://github.com/WhiskeySockets/Baileys) that provides a simple cli, php wrapper, and mcp server for fetching messages, sending direct and group messages, and wiring whatsapp into existing tooling (wordpress, node, mcp clients) without having to deal with the full baileys session lifecycle yourself.

## installation

### initial clone

```sh
git subtree add --prefix=./path/to/subfolder/wahelper git@github.com:vielhuber/charly.git main --squash
```

### update library

```sh
git subtree pull --prefix=./path/to/subfolder/wahelper git@github.com:vielhuber/charly.git main --squash
```

### install dependencies

```sh
nvm use --lts
npm install
```

## usage

### cli

```sh
node whatsapp.js --own-number "xxxxxxxxxxxx" --action "fetch_messages"
node whatsapp.js --own-number "xxxxxxxxxxxx" --action "send_user" --number "xxxxxxxxxxxx" --message "This is a test! 🚀"
node whatsapp.js --own-number "xxxxxxxxxxxx" --action "send_group" --name "Group name" --message "This is a test! 🚀"
```

### php

```php
require_once 'whatsapp.php';
WhatsApp::call([
    'own-number' => 'xxxxxxxxxxxx',
    'action' => 'fetch_messages'
]);
WhatsApp::call([
    'own-number' => 'xxxxxxxxxxxx',
    'action' => 'send_user',
    'number' => 'xxxxxxxxxxxx',
    'message' => 'This is a test! 🚀'
]);
WhatsApp::call([
    'own-number' => 'xxxxxxxxxxxx',
    'action' => 'send_group',
    'name' => 'Group name',
    'message' => 'This is a test! 🚀'
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
