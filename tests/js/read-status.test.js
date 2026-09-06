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
