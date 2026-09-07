import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import Daemon from '../../wahelper-daemon.js';

for (let format of ['history', 'upsert']) {
    test(`preserves incoming read status from ${format} chat data`, async () => {
        let database = new DatabaseSync(':memory:');
        database.exec(
            'CREATE TABLE messages (id TEXT PRIMARY KEY, `from` TEXT, `to` TEXT, content TEXT, media_data BLOB, media_filename TEXT, timestamp INTEGER, `read` INTEGER DEFAULT 0)'
        );
        let insert = database.prepare('INSERT INTO messages (id, `from`, `to`) VALUES (?, ?, ?)');
        insert.run('group-read', 'sender', 'group');
        insert.run('direct-read', 'contact', 'me');
        insert.run('group-outgoing', 'me', 'group');
        insert.run('still-unread', 'sender', 'unread-group');
        insert.run('unknown', 'sender', 'unknown-group');
        let daemon = Object.create(Daemon.prototype);
        Object.assign(daemon, { db: database, dbIsOpen: true, dbLock: false, args: { device: 'me' }, log() {} });
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
        let database = new DatabaseSync(':memory:');
        database.exec(
            'CREATE TABLE messages (id TEXT PRIMARY KEY, `from` TEXT, `to` TEXT, content TEXT, media_data BLOB, media_filename TEXT, timestamp INTEGER, `read` INTEGER DEFAULT 0)'
        );
        let insert = database.prepare('INSERT INTO messages (id, `from`, `to`) VALUES (?, ?, ?)');
        insert.run('phone', '49123456789', 'me');
        insert.run('lid', '123456', 'me');
        insert.run('outgoing', 'me', '49123456789');
        insert.run('other', '49987654321', 'me');
        let daemon = Object.create(Daemon.prototype);
        Object.assign(daemon, {
            db: database,
            dbIsOpen: true,
            dbLock: false,
            args: { device: 'me' },
            log() {},
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
            let database = new DatabaseSync(':memory:');
            database.exec(
                'CREATE TABLE messages (id TEXT PRIMARY KEY, `from` TEXT, `to` TEXT, content TEXT, media_data BLOB, media_filename TEXT, timestamp INTEGER, `read` INTEGER DEFAULT 0)'
            );
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
            let daemon = Object.create(Daemon.prototype);
            Object.assign(daemon, {
                db: database,
                dbIsOpen: true,
                dbLock: false,
                args: { device: 'me' },
                log() {},
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
