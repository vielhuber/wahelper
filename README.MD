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
    --limit 42

    # send message to user
    --action "send_user" \
    --number "xxxxxxxxxxxx" \
    --message "This is a test! 🚀"
    --attachments "/full/path/to/file.pdf,/full/path/to/image.png"

    # send message to group
    --action "send_group" \
    --name "Group name" \
    --message "This is a test! 🚀"
    --attachments "/full/path/to/file.pdf,/full/path/to/image.png"
```

### php

```php
require_once __DIR__ . '/vendor/autoload.php';
use vielhuber\wahelper\wahelper;

$wahelper = new wahelper();

// fetch messages
$wahelper->fetchMessages(device: 'xxxxxxxxxxxx', limit: 42);

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
Windows Task Scheduler > Create Task > Triggers: At startup → Actions: Start a program → Program: `C:\Users\<user>\AppData\Roaming\npm\pm2.cmd`, Arguments: `resurrect`

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
