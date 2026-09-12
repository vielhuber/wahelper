import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getMediaKeys } from 'baileys';
import Client from '../../wahelper.js';
import Daemon from '../../wahelper-daemon.js';

let execute = promisify(execFile);

describe('Public API', () => {
    for (let filename of ['wahelper.js', 'wahelper-daemon.js']) {
        test(`imports ${filename} from stdin without starting the application`, () => {
            let moduleUrl = new URL('../../' + filename, import.meta.url).href;
            let result = spawnSync(process.execPath, ['--input-type=module', '-'], {
                input: `await import(${JSON.stringify(moduleUrl)}); console.log('imported');`,
                encoding: 'utf8',
                timeout: 10000
            });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout.trim(), 'imported');
        });
    }

    for (let [argumentsList, expected] of [
        [
            [
                '--action',
                'fetch_messages',
                '--filter',
                '{"message":"meeting"}',
                '--limit',
                '42',
                '--order',
                'desc',
                '--exclude-body'
            ],
            { action: 'fetch_messages', filter: '{"message":"meeting"}', limit: 42, order: 'desc', exclude_body: true }
        ],
        [['--action', 'view_message', '--id', 'ABCDEF1234567890'], { action: 'view_message', id: 'ABCDEF1234567890' }],
        [
            [
                '--action',
                'send_user',
                '--number',
                '491234567890',
                '--message',
                'This is a test! 🚀',
                '--attachments',
                '/file.pdf,/image.png'
            ],
            {
                action: 'send_user',
                number: '491234567890',
                message: 'This is a test! 🚀',
                attachments: ['/file.pdf', '/image.png']
            }
        ],
        [
            [
                '--action',
                'send_group',
                '--name',
                'Group name',
                '--message',
                'This is a test! 🚀',
                '--attachments',
                '/file.pdf,/image.png'
            ],
            {
                action: 'send_group',
                name: 'Group name',
                message: 'This is a test! 🚀',
                attachments: ['/file.pdf', '/image.png']
            }
        ]
    ]) {
        test(`preserves the documented ${expected.action} CLI arguments`, () => {
            let originalArguments = process.argv;
            process.argv = ['node', 'wahelper.js', '--device', '491234567890', ...argumentsList];
            try {
                assert.deepEqual(Client.prototype.parseArgs(), { device: '491234567890', ...expected });
            } finally {
                process.argv = originalArguments;
            }
        });
    }
});

function createMessageDatabase(filename = ':memory:') {
    let database = new DatabaseSync(filename);
    database.exec(
        'CREATE TABLE messages (id TEXT PRIMARY KEY, `from` TEXT, `to` TEXT, content TEXT, media_data TEXT, media_filename TEXT, timestamp INTEGER, `read` INTEGER DEFAULT 0)'
    );
    return database;
}

function createDaemon(database, options = {}) {
    return Object.assign(Object.create(Daemon.prototype), {
        db: database,
        dbIsOpen: true,
        dbLock: false,
        args: { device: 'me' },
        log() {},
        ...options
    });
}

describe('Response files and errors', () => {
    test('isolates response files for requests on the same device and preserves the standalone CLI path', context => {
        let folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wahelper-response-'));
        let args = { device: '49123456789', request_id: 'a'.repeat(32) };
        context.mock.method(Client.prototype, 'parseArgs', () => args);
        context.mock.method(Client.prototype, 'getDirname', () => folder);
        context.mock.method(Client.prototype, 'getAuthToken', () => 'fixture');
        try {
            let first = new Client();
            args = { ...args, request_id: 'b'.repeat(32) };
            let second = new Client();
            assert.notEqual(first.dataPath, second.dataPath);
            assert.equal(first.dbPath, second.dbPath);
            delete args.request_id;
            assert.equal(new Client().dataPath, 'whatsapp_49123456789.json');
            args.request_id = '../invalid';
            assert.throws(() => new Client(), /request id/i);
        } finally {
            fs.rmSync(folder, { recursive: true });
        }
    });

    for (let method of ['fetchMessages', 'viewMessage']) {
        test(`${method} queues an explicit response on database errors`, async () => {
            let client = Object.create(Client.prototype);
            Object.assign(client, {
                db: new DatabaseSync(':memory:'),
                dataPath: 'response.json',
                writeOnEnd: null,
                log() {}
            });
            try {
                assert.equal(await client[method](), null);
                assert.deepEqual(client.writeOnEnd, { success: false, message: 'error', data: null });
            } finally {
                client.db.close();
            }
        });
    }

    test('publishes a complete response without overwriting the visible file in place', context => {
        let folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wahelper-response-'));
        let client = Object.create(Client.prototype);
        Object.assign(client, { dirname: folder, dataPath: 'response.json' });
        let responsePath = path.join(folder, client.dataPath);
        let loading = { success: false, message: 'loading_state' };
        let complete = { success: true, message: 'messages_fetched', data: ['fixture'] };
        fs.writeFileSync(responsePath, JSON.stringify(loading));
        let writeFile = fs.writeFileSync;
        context.mock.method(fs, 'writeFileSync', (target, ...args) => {
            assert.notEqual(target, responsePath);
            assert.deepEqual(JSON.parse(fs.readFileSync(responsePath, 'utf8')), loading);
            return writeFile(target, ...args);
        });
        try {
            client.write(complete, false);
            assert.deepEqual(JSON.parse(fs.readFileSync(responsePath, 'utf8')), complete);
            assert.deepEqual(fs.readdirSync(folder), ['response.json']);
        } finally {
            fs.rmSync(folder, { recursive: true });
        }
    });

    test('preserves the previous response and cleans temporary files if publication fails', context => {
        let folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wahelper-response-'));
        let client = Object.create(Client.prototype);
        Object.assign(client, { dirname: folder, dataPath: 'response.json' });
        let responsePath = path.join(folder, client.dataPath);
        fs.writeFileSync(responsePath, '{}');
        context.mock.method(fs, 'renameSync', () => {
            throw new Error('publication failed');
        });
        try {
            assert.throws(() => client.write({ success: true }, false), /publication failed/);
            assert.equal(fs.readFileSync(responsePath, 'utf8'), '{}');
            assert.deepEqual(fs.readdirSync(folder), ['response.json']);
        } finally {
            fs.rmSync(folder, { recursive: true });
        }
    });
});

describe('Media recovery', () => {
    test('updates redelivered fields without losing media or read status', async () => {
        let mediaKey = randomBytes(32);
        let { iv, cipherKey, macKey } = await getMediaKeys(mediaKey, 'image');
        let media = Buffer.from('local media recovery fixture');
        let cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
        let encrypted = Buffer.concat([cipher.update(media), cipher.final()]);
        let signature = createHmac('sha256', macKey).update(iv).update(encrypted).digest().subarray(0, 10);
        let attempts = 0;
        let server = createServer((request, response) => {
            response.writeHead(++attempts === 1 || attempts === 4 ? 500 : 200);
            response.end(Buffer.concat([encrypted, signature]));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        let database = createMessageDatabase();
        let daemon = createDaemon(database, {
            isFirstRun: false,
            sock: { updateMediaMessage() {} }
        });
        let fixture = {
            messages: [
                {
                    key: { id: 'media-fixture', remoteJid: '49123456789@s.whatsapp.net', fromMe: false },
                    messageTimestamp: 1,
                    message: {
                        imageMessage: {
                            url: `http://127.0.0.1:${server.address().port}/media`,
                            mediaKey,
                            caption: 'original'
                        }
                    }
                }
            ]
        };
        try {
            await daemon.storeDataToDatabase(fixture);
            assert.equal(database.prepare('SELECT media_data FROM messages').get().media_data, null);
            database.exec('UPDATE messages SET `read` = 1');
            fixture.messages[0].message.imageMessage.caption = 'redelivered';
            fixture.messages[0].messageTimestamp = 2;
            await daemon.storeDataToDatabase(fixture);
            let recovered = database.prepare('SELECT * FROM messages').get();
            assert.equal(recovered.media_data, media.toString('base64'));
            assert.equal(recovered.content, 'redelivered');
            assert.equal(recovered.timestamp, 2);
            assert.equal(recovered.read, 1);
            database.prepare('UPDATE messages SET media_data = ?').run('existing-media');
            await daemon.storeDataToDatabase(fixture);
            assert.equal(
                database.prepare('SELECT media_data FROM messages').get().media_data,
                media.toString('base64')
            );
            await daemon.storeDataToDatabase(fixture);
            assert.equal(
                database.prepare('SELECT media_data FROM messages').get().media_data,
                media.toString('base64')
            );
            assert.equal(attempts, 4);
            assert.equal(daemon.dbLock, false);
        } finally {
            database.close();
            await new Promise(resolve => server.close(resolve));
        }
    });
});

describe('Message updates', () => {
    for (let fromMe of [false, true]) {
        test(`updates content and resolved identities for ${fromMe ? 'outgoing' : 'incoming'} messages`, async () => {
            let database = createMessageDatabase();
            let daemon = createDaemon(database);
            let message = {
                key: { id: 'updated', remoteJid: '123456@lid', fromMe },
                messageTimestamp: 100,
                message: { conversation: 'original' }
            };
            try {
                await daemon.storeDataToDatabase({ messages: [message] });
                database.exec('UPDATE messages SET `read` = 1');
                message.key.remoteJidAlt = '49123456789@s.whatsapp.net';
                message.messageTimestamp = 200;
                message.message.conversation = 'updated';
                await daemon.storeDataToDatabase({ messages: [message] });
                let row = database.prepare('SELECT * FROM messages').get();
                assert.equal(row.content, 'updated');
                assert.equal(row.from, fromMe ? 'me' : '49123456789');
                assert.equal(row.to, fromMe ? '49123456789' : 'me');
                assert.equal(row.timestamp, 200);
                assert.equal(row.read, 1);
                for (let timestamp of [undefined, null, 'invalid']) {
                    message.messageTimestamp = timestamp;
                    await daemon.storeDataToDatabase({ messages: [message] });
                    assert.equal(database.prepare('SELECT timestamp FROM messages').get().timestamp, 200);
                }
                for (let timestamp of [0, '300', { toString: () => '400' }]) {
                    message.messageTimestamp = timestamp;
                    await daemon.storeDataToDatabase({ messages: [message] });
                    assert.equal(database.prepare('SELECT timestamp FROM messages').get().timestamp, Number(timestamp));
                }
            } finally {
                database.close();
            }
        });
    }

    test('handles edit events without replacing the original send time or resetting read status', async () => {
        let database = createMessageDatabase();
        let daemon = createDaemon(database);
        let key = { id: 'edited', remoteJid: '49123456789@s.whatsapp.net', fromMe: false };
        try {
            await daemon.storeDataToDatabase({
                messages: [{ key, messageTimestamp: 100, message: { conversation: 'original' }, status: 4 }]
            });
            await daemon.storeDataToDatabase({
                updates: [
                    {
                        key,
                        update: {
                            messageTimestamp: 200,
                            message: { editedMessage: { message: { conversation: 'edited text' } } }
                        }
                    }
                ]
            });
            let row = database.prepare('SELECT * FROM messages').get();
            assert.equal(row.content, 'edited text');
            assert.equal(row.timestamp, 100);
            assert.equal(row.read, 1);
            await daemon.storeDataToDatabase({
                updates: [
                    { key, update: { status: 2 } },
                    { key, update: { message: null } }
                ]
            });
            assert.deepEqual(database.prepare('SELECT * FROM messages').get(), row);
            assert.equal(database.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 1);
        } finally {
            database.close();
        }
    });

    test('clears an edited media caption but preserves downloaded media when the new download fails', async () => {
        let database = createMessageDatabase();
        let daemon = createDaemon(database, { isFirstRun: false, sock: { updateMediaMessage() {} } });
        let key = { id: 'caption', remoteJid: '49123456789@s.whatsapp.net', fromMe: false };
        database
            .prepare(
                'INSERT INTO messages (id, `from`, `to`, content, media_data, media_filename, timestamp, `read`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .run(key.id, '49123456789', 'me', 'original caption', 'stored-media', 'original.jpg', 100, 1);
        try {
            await daemon.storeDataToDatabase({
                updates: [
                    {
                        key,
                        update: {
                            messageTimestamp: 200,
                            message: { editedMessage: { message: { imageMessage: { caption: '' } } } }
                        }
                    }
                ]
            });
            let row = database.prepare('SELECT * FROM messages').get();
            assert.equal(row.content, null);
            assert.equal(row.media_data, 'stored-media');
            assert.equal(row.media_filename, 'caption.jpg');
            assert.equal(row.timestamp, 100);
            assert.equal(row.read, 1);
            daemon.isFirstRun = true;
            database.prepare('UPDATE messages SET content = ?').run('existing caption');
            await daemon.storeDataToDatabase({
                messages: [{ key, messageTimestamp: 100, message: { imageMessage: {} } }]
            });
            row = database.prepare('SELECT * FROM messages').get();
            assert.equal(row.content, 'existing caption');
            assert.equal(row.media_data, 'stored-media');
            assert.equal(row.media_filename, 'caption.jpg');
        } finally {
            database.close();
        }
    });
});

describe('Read status', () => {
    for (let format of ['history', 'upsert']) {
        test(`preserves incoming read status from ${format} chat data`, async () => {
            let database = createMessageDatabase();
            let insert = database.prepare('INSERT INTO messages (id, `from`, `to`) VALUES (?, ?, ?)');
            insert.run('group-read', 'sender', 'group');
            insert.run('direct-read', 'contact', 'me');
            insert.run('group-outgoing', 'me', 'group');
            insert.run('still-unread', 'sender', 'unread-group');
            insert.run('unknown', 'sender', 'unknown-group');
            let daemon = createDaemon(database);
            let chats = [
                { id: 'group@g.us', unreadCount: 0 },
                { id: 'contact@s.whatsapp.net', unreadCount: 0 },
                { id: 'unread-group@g.us', unreadCount: 1 },
                { id: 'unknown-group@g.us' }
            ];
            try {
                await daemon.storeDataToDatabase(format === 'history' ? { messages: [], chats } : chats);
                let rows = database.prepare('SELECT id, `read` FROM messages ORDER BY id').all();
                assert.deepEqual(
                    Array.from(rows, row => [row.id, row.read]),
                    [
                        ['direct-read', 1],
                        ['group-outgoing', 0],
                        ['group-read', 1],
                        ['still-unread', 0],
                        ['unknown', 0]
                    ]
                );
                assert.equal(daemon.dbLock, false);
            } finally {
                database.close();
            }
        });
    }

    for (let format of ['update', 'history', 'upsert']) {
        test(`resolves read LIDs in ${format} without marking unrelated messages`, async () => {
            let database = createMessageDatabase();
            let insert = database.prepare('INSERT INTO messages (id, `from`, `to`) VALUES (?, ?, ?)');
            insert.run('phone', '49123456789', 'me');
            insert.run('lid', '123456', 'me');
            insert.run('outgoing', 'me', '49123456789');
            insert.run('other', '49987654321', 'me');
            let daemon = createDaemon(database, {
                sock: {
                    signalRepository: {
                        lidMapping: {
                            async getPNForLID(id) {
                                assert.equal(id, '123456@lid');
                                return '49123456789:0@s.whatsapp.net';
                            }
                        }
                    }
                }
            });
            let chats = [{ id: '123456@lid', unreadCount: 0 }];
            try {
                if (format === 'update') await daemon.markChatsRead(chats);
                if (format === 'history') await daemon.storeDataToDatabase({ messages: [], chats });
                if (format === 'upsert') await daemon.storeDataToDatabase(chats);
                assert.deepEqual(
                    database
                        .prepare('SELECT id, `read` FROM messages ORDER BY id')
                        .all()
                        .map(row => [row.id, row.read]),
                    [
                        ['lid', 1],
                        ['other', 0],
                        ['outgoing', 0],
                        ['phone', 1]
                    ]
                );
                assert.equal(daemon.dbLock, false);
            } finally {
                database.close();
            }
        });
    }

    for (let format of ['update', 'history', 'upsert']) {
        for (let chatType of ['direct', 'group', 'lid']) {
            test(`marks only the latest incoming ${chatType} message unread via ${format}`, async () => {
                let database = createMessageDatabase();
                let insert = database.prepare(
                    'INSERT INTO messages (id, `from`, `to`, timestamp, `read`) VALUES (?, ?, ?, ?, ?)'
                );
                let contact = chatType === 'lid' ? '49123456789' : 'contact';
                let sender = chatType === 'group' ? 'sender' : contact;
                let recipient = chatType === 'group' ? 'group' : 'me';
                insert.run('already-unread', sender, recipient, 1, 0);
                insert.run('old-read', chatType === 'lid' ? '123456' : sender, recipient, 2, 1);
                insert.run('same-second', sender, recipient, 3, 1);
                insert.run('latest-incoming', sender, recipient, 3, 1);
                insert.run('own', 'me', chatType === 'group' ? 'group' : contact, 4, 1);
                insert.run('other-chat', 'someone-else', 'me', 5, 1);
                let daemon = createDaemon(database, {
                    sock: {
                        signalRepository: {
                            lidMapping: {
                                async getPNForLID() {
                                    return '49123456789:0@s.whatsapp.net';
                                }
                            }
                        }
                    }
                });
                let chatId =
                    chatType === 'group' ? 'group@g.us' : chatType === 'lid' ? '123456@lid' : 'contact@s.whatsapp.net';
                try {
                    for (let repeat = 0; repeat < 2; repeat++) {
                        let chats = [{ id: chatId, unreadCount: -1 }];
                        if (format === 'update') await daemon.markChatsRead(chats);
                        if (format === 'history') await daemon.storeDataToDatabase({ messages: [], chats });
                        if (format === 'upsert') await daemon.storeDataToDatabase(chats);
                        assert.deepEqual(
                            database
                                .prepare('SELECT id FROM messages WHERE `read` = 0 ORDER BY id')
                                .all()
                                .map(row => row.id),
                            ['already-unread', 'latest-incoming']
                        );
                        assert.equal(daemon.dbLock, false);
                    }
                    await daemon.markChatsRead([{ id: chatId, unreadCount: 0 }]);
                    assert.equal(
                        database.prepare('SELECT COUNT(*) AS count FROM messages WHERE `read` = 0').get().count,
                        0
                    );
                    await daemon.markChatsRead([
                        { id: chatId, unreadCount: 2 },
                        { id: chatId, unreadCount: null },
                        { id: chatId }
                    ]);
                    assert.equal(
                        database.prepare('SELECT COUNT(*) AS count FROM messages WHERE `read` = 0').get().count,
                        0
                    );
                    await daemon.markChatsRead([{ id: 'empty@s.whatsapp.net', unreadCount: -1 }]);
                    assert.equal(
                        database.prepare('SELECT COUNT(*) AS count FROM messages WHERE `read` = 0').get().count,
                        0
                    );
                } finally {
                    database.close();
                }
            });
        }
    }
});

describe('PHP and CLI integration', () => {
    test('preserves PHP and CLI calls and separates concurrent responses', async () => {
        let root = fileURLToPath(new URL('../../', import.meta.url));
        let folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wahelper-php-integration-'));
        let device = '49123456789';
        let dataFolder = path.join(folder, 'whatsapp_data');
        fs.mkdirSync(dataFolder);
        for (let filename of ['wahelper.php', 'wahelper.js']) {
            fs.copyFileSync(path.join(root, filename), path.join(folder, filename));
        }
        fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ type: 'module' }));
        fs.symlinkSync(path.join(root, 'node_modules'), path.join(folder, 'node_modules'), 'junction');
        let database = createMessageDatabase(path.join(dataFolder, `whatsapp_${device}.sqlite`));
        let insert = database.prepare('INSERT INTO messages (id, content, timestamp) VALUES (?, ?, ?)');
        insert.run('first', 'first', 1);
        insert.run('second', 'second', 2);
        database.close();
        try {
            let results = await Promise.allSettled(
                ['first', 'second'].map(message =>
                    execute(
                        'php',
                        [
                            '-r',
                            `require $argv[1];
                            define('NODE_PATH', $argv[2]);
                            $helper = new \\vielhuber\\wahelper\\wahelper();
                            (new ReflectionProperty($helper, 'timeout'))->setValue($helper, 10);
                            echo json_encode($helper->fetchMessages(
                                device: $argv[3],
                                filter: ['message' => $argv[4]]
                            ));`,
                            path.join(folder, 'wahelper.php'),
                            process.execPath,
                            device,
                            message
                        ],
                        { timeout: 20000 }
                    )
                )
            );
            for (let [index, result] of results.entries()) {
                assert.equal(result.status, 'fulfilled', result.reason?.message);
                assert.equal(result.value.stderr, '');
                let response = JSON.parse(result.value.stdout);
                assert.equal(response.success, true);
                assert.equal(response.message, 'messages_fetched');
                assert.deepEqual(
                    response.data.map(message => message.id),
                    [index === 0 ? 'first' : 'second']
                );
            }
            let logPath = path.join(dataFolder, `whatsapp_${device}.log`);
            let deadline = Date.now() + 5000;
            while ((fs.readFileSync(logPath, 'utf8').match(/final exit/g) || []).length < 2 && Date.now() < deadline) {
                await setTimeout(50);
            }
            let log = fs.readFileSync(logPath, 'utf8');
            assert.equal((log.match(/final exit/g) || []).length, 2);
            let requests = [...log.matchAll(/"request_id": "([a-f0-9]{32})"/g)].map(match => match[1]);
            assert.equal(new Set(requests).size, 2);
            assert.equal(
                fs.readdirSync(dataFolder).some(filename => /\.(json|bat|tmp)$/.test(filename)),
                false
            );
            let entryPoint = path.join(folder, 'wahelper.js');
            if (process.platform !== 'win32') {
                let commandLink = path.join(folder, 'wahelper-command');
                fs.symlinkSync(entryPoint, commandLink);
                entryPoint = commandLink;
            }
            await execute(
                process.execPath,
                [
                    entryPoint,
                    '--device',
                    device,
                    '--action',
                    'fetch_messages',
                    '--filter',
                    '{"message":"first"}',
                    '--limit',
                    '1',
                    '--order',
                    'asc',
                    '--exclude-body'
                ],
                { timeout: 10000 }
            );
            let responsePath = path.join(dataFolder, `whatsapp_${device}.json`);
            let fetched = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
            assert.equal(fetched.success, true);
            assert.equal(fetched.message, 'messages_fetched');
            assert.deepEqual(
                fetched.data.map(message => message.id),
                ['first']
            );
            assert.equal(Object.hasOwn(fetched.data[0], 'content'), false);
            await execute(
                process.execPath,
                [entryPoint, '--device', device, '--action', 'view_message', '--id', 'second'],
                { timeout: 10000 }
            );
            let viewed = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
            assert.equal(viewed.success, true);
            assert.equal(viewed.message, 'message_fetched');
            assert.equal(viewed.data.id, 'second');
            assert.equal(viewed.data.content, 'second');
        } finally {
            fs.rmSync(folder, { recursive: true });
        }
    });
});
