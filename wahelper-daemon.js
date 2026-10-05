#!/usr/bin/env -S NODE_NO_WARNINGS=1 node

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    downloadAndProcessHistorySyncNotification,
    getHistoryMsg,
    extractMessageContent,
    fetchLatestBaileysVersion,
    normalizeMessageContent,
    jidDecode,
    jidNormalizedUser,
    Browsers,
    proto
} from 'baileys';
import P from 'pino';
import qrcodeTerminal from 'qrcode-terminal';

// set to false to use QR code instead
const USE_PAIRING_CODE = true;
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import http from 'http';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';

export default class wahelperDaemon {
    static HISTORY_REQUEST_TIMEOUT = 60000;
    static HISTORY_RETRY_DELAY = 5 * 60000;

    constructor() {
        this.args = this.parseArgs();
        this.dirname = this.getDirname();
        if (!fs.existsSync(this.dirname)) {
            fs.mkdirSync(this.dirname, { recursive: true });
        }
        this.sock = null;
        this.db = null;
        this.dbIsOpen = false;
        this.dbLock = false;
        this.connected = false;
        this.connecting = false;
        this.loggedOut = false;
        this.qr = null;
        this.pairingCode = null;
        this.pairingCodeRequested = false;
        this.lastError = null;
        this.isFirstRun = false;
        this.reconnectDelay = 1000;
        this.consecutiveFailures = 0;
        this.connectionAttempt = null;
        this.connectionTimeout = null;
        this.httpServer = null;
        this.history = { running: false, lastError: null };
        this.historyRequest = null;

        if (this.args.device) {
            this.device = this.formatNumber(this.args.device);
            this.authFolder = 'auth_' + this.device;
            this.dbPath = 'whatsapp_' + this.device + '.sqlite';
            this.logPath = 'whatsapp_' + this.device + '.log';
            this.port = this.computePort(this.device);
            this.authToken = this.getAuthToken();
        }
    }

    getDirname() {
        let projectRoot,
            currentDir = dirname(fileURLToPath(import.meta.url));
        if (currentDir.includes('node_modules')) {
            projectRoot = dirname(dirname(dirname(currentDir)));
            if (!fs.existsSync(projectRoot + '/package.json')) {
                projectRoot = process.cwd();
            }
        } else if (currentDir.includes('vendor')) {
            projectRoot = dirname(dirname(dirname(currentDir)));
        } else {
            projectRoot = currentDir;
        }
        return projectRoot + '/whatsapp_data';
    }

    parseArgs() {
        let args = {};
        let argv = process.argv.slice(2);
        for (let i = 0; i < argv.length; i++) {
            if (!argv[i].startsWith('-')) {
                continue;
            }
            let parts = argv[i].split('='),
                key = parts[0].replace(/^-+/, '').replace(/-/g, '_'),
                value;
            // --key=value
            if (parts.length > 1) {
                value = parts
                    .slice(1)
                    .join('=')
                    .replace(/^["']|["']$/g, '');
            }
            // --key value
            else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
                value = argv[i + 1];
                i++;
            }
            // --key (boolean flag)
            else {
                value = true;
            }
            args[key] = value;
        }
        return args;
    }

    computePort(device) {
        // range 29000-31999: below linux ephemeral (32768+) and windows ephemeral (49152+)
        return 29000 + (parseInt(device.slice(-5)) % 3000);
    }

    getAuthToken() {
        let path = this.dirname + '/whatsapp_' + this.device + '.token';
        if (fs.existsSync(path)) {
            let token = fs.readFileSync(path, 'utf8').trim();
            if (token !== '') {
                try {
                    fs.chmodSync(path, 0o600);
                } catch (_) {}
                return token;
            }
        }
        let token = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(path, token, { mode: 0o600 });
        return token;
    }

    isAuthorized(req) {
        let token = req.headers['x-wahelper-token'];
        if (Array.isArray(token)) {
            token = token[0];
        }
        if (typeof token !== 'string' || token === '') {
            return false;
        }
        let expected = Buffer.from(this.authToken);
        let actual = Buffer.from(token);
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }

    formatNumber(number) {
        // replace leading zero with 49
        number = number.replace(/^0+/, '49');
        // remove non-digit characters
        number = number.replace(/\D/g, '');
        return number;
    }

    log(...args) {
        if (this.logPath === undefined) {
            return;
        }
        let message = args.map(arg => (typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg)).join(' ');
        let logLine = new Date().toISOString() + ' - ' + message + '\n';
        fs.appendFileSync(this.dirname + '/' + this.logPath, logLine);
    }

    initDatabase() {
        try {
            this.db = new DatabaseSync(this.dirname + '/' + this.dbPath);
            this.dbIsOpen = true;
            this.db.exec('PRAGMA journal_mode = WAL');
            this.db.exec('PRAGMA busy_timeout = 5000');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    \`from\` TEXT,
                    \`to\` TEXT,
                    content TEXT,
                    media_data TEXT,
                    media_filename TEXT,
                    timestamp INTEGER,
                    \`read\` INTEGER NOT NULL DEFAULT 0
                );
            `);
            let cols = this.db.prepare('PRAGMA table_info(messages)').all();
            if (!cols.some(c => c.name === 'read')) {
                this.db.exec('ALTER TABLE messages ADD COLUMN `read` INTEGER NOT NULL DEFAULT 0');
            }
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS history_messages (
                    id TEXT PRIMARY KEY, jid TEXT NOT NULL, message_key TEXT NOT NULL,
                    timestamp INTEGER NOT NULL, stored INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS history_messages_chat ON history_messages (jid, timestamp);
                CREATE TABLE IF NOT EXISTS history_chats (
                    jid TEXT PRIMARY KEY, oldest_key TEXT, oldest_timestamp INTEGER,
                    complete INTEGER NOT NULL DEFAULT 0, last_attempt INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT
                );
            `);
        } catch (error) {
            this.log('⛔ Error initing database: ' + error.message + ' (code: ' + error.code + ')');
        }
    }

    // resolve a jid + its baileys "alt" counterpart (remoteJidAlt / participantAlt,
    // which carries the opposite id type) into { pn, lid } — purely from the message.
    resolveIdentity(primaryJid, altJid) {
        let out = { pn: null, lid: null };
        let classify = jid => {
            if (!jid || typeof jid !== 'string') {
                return;
            }
            let bare = jid.replace(/@.*$/, '');
            if (bare === '') {
                return;
            }
            if (jid.endsWith('@lid')) {
                out.lid = bare;
            } else if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) {
                out.pn = bare;
            }
        };
        classify(primaryJid);
        classify(altJid);
        return out;
    }

    formatMessage(message) {
        if (message === null || message === undefined || message === '') {
            return message;
        }
        // replace nbsp with spaces
        message = message.replace(/&nbsp;/g, ' ');
        // replace <br> with real line breaks
        message = message.replace(/<br\s*\/?>/gis, '\n');
        // replace <p></p> with line breaks
        message = message.replace(/<p(?:\s[^>]*)?\>(.*?)<\/p>/gis, '\n$1\n');
        // replace " </x>" with "</x> " (multiple times)
        message = message.replace(/ +(\<\/[a-z]+\>)/gis, '$1 ');
        message = message.replace(/ +(\<\/[a-z]+\>)/gis, '$1 ');
        message = message.replace(/ +(\<\/[a-z]+\>)/gis, '$1 ');
        // replace  "<x> " with " <x>" (multiple times)
        message = message.replace(/(\<[a-z]+(?:\s[^>]*)?\>) +/gis, ' $1');
        message = message.replace(/(\<[a-z]+(?:\s[^>]*)?\>) +/gis, ' $1');
        message = message.replace(/(\<[a-z]+(?:\s[^>]*)?\>) +/gis, ' $1');
        // replace " \n" with "\n"
        message = message.replace(/ \n/gis, '\n');
        // remove "<x> </x>"
        message = message.replace(/<([a-z]+)(?:\s[^>]*)?\>\s*<\/\1>/gis, '');
        // replace <strong>...</strong> with "*"
        message = message.replace(/<strong(?:\s[^>]*)?\>(.*?)<\/strong>/gi, '*$1*');
        // replace <em></em> with "_"
        message = message.replace(/<em(?:\s[^>]*)?\>(.*?)<\/em>/gi, '_$1_');
        // replace <i></i> with "_"
        message = message.replace(/<i(?:\s[^>]*)?\>(.*?)<\/i>/gi, '_$1_');
        // replace <ul> with line break
        message = message.replace(/<ul(?:\s[^>]*)?\>(.*?)<\/ul>/gis, '\n$1\n');
        // replace "<li></li>" with " - "
        message = message.replace(/<li(?:\s[^>]*)?\>(.*?)<\/li>/gis, ' - $1\n');
        // replace html entities
        message = message.replace(/&quot;/g, '"');
        message = message.replace(/&#39;/g, "'");
        message = message.replace(/&amp;/g, '&');
        message = message.replace(/&lt;/g, '<');
        message = message.replace(/&gt;/g, '>');
        // strip all other tags
        message = message.replace(/<\/?[^>]+(>|$)/g, '');
        // remove all other html entities
        message = message.replace(/&[^;]+;/g, '');
        return message;
    }

    getAttachmentObj(attachment) {
        let ext = (attachment.split('.').pop() || '').toLowerCase();
        if (ext === 'jpg' || ext === 'jpeg' || ext === 'png') {
            return {
                image: fs.readFileSync(attachment)
            };
        }
        let map = {
                pdf: 'application/pdf',
                docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                txt: 'text/plain'
            },
            mime_type = map[ext] || 'application/octet-stream';
        return {
            document: fs.readFileSync(attachment),
            fileName: attachment.split('/').splice(-1),
            mimetype: mime_type
        };
    }

    async storeDataToDatabase(data) {
        this.log('storeDataToDatabase');

        let messages = Array.isArray(data?.messages) ? data.messages : [];
        if (Array.isArray(data?.updates)) {
            messages = data.updates
                .filter(({ update }) => update?.message?.editedMessage)
                .map(({ key, update }) => ({ ...update, key }));
        }
        let chats = Array.isArray(data) ? data : Array.isArray(data?.chats) ? data.chats : [];
        if (messages.length === 0 && chats.length === 0) {
            return;
        }

        // wait for any existing db operation to finish
        while (this.dbLock) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        this.dbLock = true;

        let count = 0,
            length = messages.length;

        // if db is closed in the meantime
        if (this.dbIsOpen === false) {
            this.initDatabase();
        }

        try {
            this.log('BEGIN TRANSACTION');
            this.db.exec('BEGIN TRANSACTION');
            let query = this.db.prepare(`
                INSERT OR IGNORE INTO messages
                (id, \`from\`, \`to\`, content, media_data, media_filename, timestamp)
                VALUES ($id, $from, $to, $content, $mediaData, $mediaFilename, $timestamp)
                ON CONFLICT(id) DO UPDATE SET
                    \`from\` = excluded.\`from\`,
                    \`to\` = excluded.\`to\`,
                    content = CASE WHEN $preserveContent THEN messages.content ELSE excluded.content END,
                    media_data = COALESCE(excluded.media_data, messages.media_data),
                    media_filename = COALESCE(excluded.media_filename, messages.media_filename),
                    timestamp = CASE WHEN $preserveTimestamp THEN messages.timestamp ELSE excluded.timestamp END
            `);

            for (let messages__value of messages) {
                let id = messages__value.key?.id,
                    chatId = messages__value.key?.remoteJid,
                    fromMe = messages__value.key?.fromMe ? 1 : 0,
                    timestamp = Number(messages__value.messageTimestamp ?? NaN);
                let isEdited = messages__value.message?.editedMessage !== undefined;
                // Edit events carry the edit time, not the original send time.
                let preserveTimestamp = isEdited || isNaN(timestamp);

                // status posts and newsletter items are not conversations. they carry
                // their author in remoteJidAlt, so without this they would be stored
                // as a regular one-to-one message from that contact.
                if (chatId === 'status@broadcast' || chatId?.endsWith('@newsletter')) {
                    continue;
                }

                if (isNaN(timestamp)) {
                    timestamp = Math.floor(Date.now() / 1000);
                }

                // resolve the human partner's jid to the phone number; the group
                // chat (and "me") stay as-is, only the contact id gets canonicalized.
                let isGroup = chatId?.endsWith('@g.us');
                let me = this.args.device || 'me';
                let from = null;
                let to = null;
                if (isGroup) {
                    to = chatId ? chatId.replace(/@.*$/, '') : null;
                    if (fromMe) {
                        from = me;
                    } else {
                        let participantJid = messages__value?.participant || messages__value?.key?.participant || null;
                        let ident = this.resolveIdentity(participantJid, messages__value?.key?.participantAlt || null);
                        from = ident.pn || ident.lid || (participantJid || '').replace(/@.*$/, '');
                    }
                } else {
                    let ident = this.resolveIdentity(chatId || null, messages__value?.key?.remoteJidAlt || null);
                    let partnerId = ident.pn || ident.lid || (chatId || '').replace(/@.*$/, '');
                    if (fromMe) {
                        from = me;
                        to = partnerId;
                    } else {
                        from = partnerId;
                        to = me;
                    }
                }

                if (from === null || from === undefined || from === '') {
                    this.log('⛔missing from⛔');
                    this.log(messages__value);
                    continue;
                }
                if (to === null || to === undefined || to === '') {
                    this.log('⛔missing to⛔');
                    this.log(messages__value);
                    continue;
                }

                let content = null,
                    preserveContent = false,
                    mediaFilename = null,
                    mediaData = null,
                    mediaBufferInput = null;

                // disappearing, view-once, edited and document-with-caption messages wrap
                // the real payload one or more levels deep — unwrap once so every branch
                // below sees the same shape
                let payload = normalizeMessageContent(messages__value.message);
                let mediaMessage = { key: messages__value.key, message: payload };

                if (payload?.conversation) {
                    content = payload.conversation;
                } else if (payload?.extendedTextMessage?.text) {
                    content = payload.extendedTextMessage.text;
                } else if (payload?.imageMessage) {
                    content = payload.imageMessage.caption || null;
                    mediaFilename = id + '.jpg';
                    mediaBufferInput = mediaMessage;
                } else if (payload?.stickerMessage) {
                    content = payload.stickerMessage.caption || null;
                    mediaFilename = id + '.webp';
                    mediaBufferInput = mediaMessage;
                } else if (payload?.videoMessage) {
                    content = payload.videoMessage.caption || null;
                    mediaFilename = id + '.mp4';
                    mediaBufferInput = mediaMessage;
                } else if (payload?.ptvMessage) {
                    // a video note is a videoMessage under a different key, and baileys'
                    // media downloader has no path for "ptv" — hand it the video it is
                    content = payload.ptvMessage.caption || null;
                    mediaFilename = id + '.mp4';
                    mediaBufferInput = { key: messages__value.key, message: { videoMessage: payload.ptvMessage } };
                } else if (payload?.documentMessage) {
                    content = payload.documentMessage.caption || null;
                    mediaFilename = payload.documentMessage.fileName || id + '.bin';
                    mediaBufferInput = mediaMessage;
                } else if (payload?.audioMessage) {
                    content = payload.audioMessage.caption || null;
                    mediaFilename = id + '.ogg';
                    mediaBufferInput = mediaMessage;
                } else if (
                    payload?.pollCreationMessage ||
                    payload?.pollCreationMessageV2 ||
                    payload?.pollCreationMessageV3 ||
                    payload?.pollCreationMessageV4
                ) {
                    // a poll is a turn of its own: without it a reader cannot tell that a
                    // question was already answered by putting it to a vote
                    let poll =
                        payload.pollCreationMessage ||
                        payload.pollCreationMessageV2 ||
                        payload.pollCreationMessageV3 ||
                        payload.pollCreationMessageV4;
                    content =
                        '[Poll] ' +
                        (poll.name || '') +
                        (poll.options || []).map(option => '\n- ' + (option.optionName || '')).join('');
                } else if (payload?.pollUpdateMessage) {
                    // the vote itself is encrypted against the poll, but the fact that
                    // somebody voted is the part that says "this was answered"
                    content = '[Poll vote] on message ' + (payload.pollUpdateMessage.pollCreationMessageKey?.id || '');
                } else if (payload?.reactionMessage?.text) {
                    // an emoji reaction counts as having replied; an empty text means the
                    // reaction was withdrawn and carries nothing worth storing
                    content =
                        '[Reaction] ' +
                        payload.reactionMessage.text +
                        ' to message ' +
                        (payload.reactionMessage.key?.id || '');
                } else if (payload?.locationMessage) {
                    content =
                        '[Location] ' +
                        [
                            payload.locationMessage.name,
                            payload.locationMessage.address,
                            payload.locationMessage.degreesLatitude + ', ' + payload.locationMessage.degreesLongitude,
                            payload.locationMessage.comment
                        ]
                            .filter(part => part !== null && part !== undefined && part !== '')
                            .join(' | ');
                } else if (payload?.liveLocationMessage) {
                    content =
                        '[Live location] ' +
                        payload.liveLocationMessage.degreesLatitude +
                        ', ' +
                        payload.liveLocationMessage.degreesLongitude +
                        (payload.liveLocationMessage.caption ? ' | ' + payload.liveLocationMessage.caption : '');
                } else if (payload?.contactMessage) {
                    content =
                        '[Contact] ' +
                        (payload.contactMessage.displayName || '') +
                        (payload.contactMessage.vcard ? '\n' + payload.contactMessage.vcard : '');
                } else if (payload?.contactsArrayMessage) {
                    content =
                        '[Contacts] ' +
                        (payload.contactsArrayMessage.contacts || [])
                            .map(contact => contact.displayName || '')
                            .filter(name => name !== '')
                            .join(', ');
                } else if (payload?.groupInviteMessage) {
                    content =
                        '[Group invite] ' +
                        (payload.groupInviteMessage.groupName || payload.groupInviteMessage.groupJid || '') +
                        (payload.groupInviteMessage.caption ? '\n' + payload.groupInviteMessage.caption : '');
                } else if (payload?.eventMessage) {
                    content =
                        '[Event] ' +
                        (payload.eventMessage.isCanceled === true ? '(canceled) ' : '') +
                        (payload.eventMessage.name || '') +
                        (payload.eventMessage.description ? '\n' + payload.eventMessage.description : '');
                } else if (extractMessageContent(payload)?.conversation) {
                    // buttons, lists and templates carry their text one wrapper deeper;
                    // baileys already knows where, so ask it instead of unpacking each one
                    content = extractMessageContent(payload).conversation;
                } else {
                    continue;
                }

                // skip media download on first run (initial history sync after fresh pairing)
                if (this.isFirstRun && !isEdited) {
                    if (content === null || content === '') {
                        preserveContent = true;
                        content = '[Media message not downloaded on first run]';
                    }
                    mediaFilename = null;
                    mediaBufferInput = null;
                }

                if (mediaBufferInput !== null) {
                    try {
                        let buffer = await downloadMediaMessage(
                            mediaBufferInput,
                            'buffer',
                            {},
                            {
                                logger: P({ level: 'silent' }),
                                reuploadRequest: this.sock.updateMediaMessage
                            }
                        );
                        mediaData = buffer.toString('base64');
                        this.log('✅ Downloaded media ' + mediaFilename);
                    } catch (error) {
                        this.log('⚠️ Failed to download media: ' + error.message + '. Leaving media data empty.');
                    }
                }

                query.run({
                    id,
                    from,
                    to,
                    content,
                    mediaData,
                    mediaFilename,
                    timestamp,
                    preserveContent: Number(preserveContent),
                    preserveTimestamp: Number(preserveTimestamp)
                });
                count++;

                if (length < 100 || count % 100 === 0) {
                    let percent = Math.round((count / length) * 100);
                    this.log('syncing progress: ' + percent + '%');
                    process.stdout.write('\r📥 Syncing messages... ' + count + '/' + length + ' (' + percent + '%)');
                }
            }

            await this.applyReadFlags(messages, chats);
            if (this.history) {
                await this.storeHistory(messages, chats);
            }

            this.db.exec('COMMIT');
            this.log('END TRANSACTION');
            if (count > 0) {
                this.log('Stored ' + count + ' messages to database (' + length + ' total received)');
                process.stdout.write(
                    '\r✅ Stored ' +
                        count +
                        ' messages to database (' +
                        length +
                        ' total received)' +
                        ' '.repeat(10) +
                        '\n'
                );
            }
        } catch (error) {
            this.log('⛔ Error storing message: ' + error.message + ' (code: ' + error.code + ')');
            try {
                this.db.exec('ROLLBACK');
                this.log('END TRANSACTION');
                this.log('✅ Transaction rolled back');
            } catch (rollbackError) {
                this.log('⛔ Rollback failed: ' + rollbackError.message);
            }
            this.dbLock = false;
            return false;
        }

        this.dbLock = false;
        return true;
    }

    async storeHistory(messages, chats = []) {
        let insertChat = this.db.prepare('INSERT OR IGNORE INTO history_chats (jid) VALUES (?)');
        let insertMessage = this.db.prepare(`
            INSERT INTO history_messages (id, jid, message_key, timestamp, stored) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET jid = excluded.jid, message_key = excluded.message_key,
                stored = MAX(history_messages.stored, excluded.stored)
        `);
        let oldestMessage = this.db.prepare(`
            UPDATE history_chats SET oldest_key = ?, oldest_timestamp = ?, complete = 0
            WHERE jid = ? AND (oldest_timestamp IS NULL OR oldest_timestamp > ?
                OR (oldest_timestamp = ? AND ?))
        `);
        let phoneJids = new Map(chats.filter(chat => chat.pnJid).map(chat => [chat.id, chat.pnJid]));
        for (let message of messages) {
            let key = message.key;
            let timestamp = Number(message.messageTimestamp);
            if (
                !key?.id ||
                !/@(s\.whatsapp\.net|lid|g\.us)$/.test(key.remoteJid || '') ||
                !Number.isFinite(timestamp) ||
                message.message?.editedMessage ||
                normalizeMessageContent(message.message)?.protocolMessage
            ) {
                continue;
            }
            let jid = key.remoteJid;
            let identity = this.resolveIdentity(jid, key.remoteJidAlt);
            let phoneJid = phoneJids.get(jid) || (identity.pn ? identity.pn + '@s.whatsapp.net' : null);
            if (!phoneJid && jid.endsWith('@lid')) {
                phoneJid = await this.sock.signalRepository.lidMapping.getPNForLID(jid);
            }
            jid = phoneJid ? jidNormalizedUser(phoneJid) : jid;
            let serializedKey = JSON.stringify(key);
            let isNew = this.db.prepare('SELECT 1 FROM history_messages WHERE id = ?').get(key.id) === undefined;
            insertChat.run(jid);
            let stored = this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(key.id) !== undefined;
            insertMessage.run(key.id, jid, serializedKey, timestamp, Number(stored));
            oldestMessage.run(serializedKey, timestamp, jid, timestamp, timestamp, Number(isNew));
        }
        for (let chat of chats) {
            if (!/@(s\.whatsapp\.net|lid|g\.us)$/.test(chat.id || '')) {
                continue;
            }
            let phoneJid = chat.pnJid;
            if (!phoneJid && chat.id.endsWith('@lid')) {
                phoneJid = await this.sock.signalRepository.lidMapping.getPNForLID(chat.id);
            }
            let jid = phoneJid ? jidNormalizedUser(phoneJid) : chat.id;
            insertChat.run(jid);
            if (
                chat.endOfHistoryTransferType ===
                proto.Conversation.EndOfHistoryTransferType.COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY
            ) {
                this.db.prepare('UPDATE history_chats SET complete = 1, last_error = NULL WHERE jid = ?').run(jid);
            }
            if (
                chat.endOfHistoryTransferType ===
                    proto.Conversation.EndOfHistoryTransferType.COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY ||
                chat.endOfHistoryTransferType ===
                    proto.Conversation.EndOfHistoryTransferType.COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY
            ) {
                this.db.prepare('UPDATE history_chats SET complete = 0 WHERE jid = ?').run(jid);
            }
        }
        this.db.exec(`
            DELETE FROM history_chats WHERE oldest_key IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM history_messages WHERE jid = history_chats.jid)
        `);
    }

    async syncHistory() {
        if (this.history.running || !this.connected || !this.sock?.ws?.isOpen) {
            return;
        }
        this.history.running = true;
        this.history.lastError = null;
        let socket = this.sock;
        try {
            // Older caches did not retain Baileys keys; recover their conversation boundaries once.
            let legacyMessages = this.db
                .prepare(
                    `
                SELECT id, \`from\`, \`to\`, timestamp FROM messages
                WHERE id NOT IN (SELECT id FROM history_messages) ORDER BY timestamp ASC
            `
                )
                .all();
            if (legacyMessages.length) {
                let groups = await socket.groupFetchAllParticipating();
                let messages = [];
                for (let message of legacyMessages) {
                    let fromMe = message.from === this.device;
                    let peer = fromMe ? message.to : message.from;
                    let group =
                        groups[message.to + '@g.us'] || (message.from !== this.device && message.to !== this.device);
                    let jid = group ? message.to + '@g.us' : peer + '@s.whatsapp.net';
                    if (!group && (await socket.signalRepository.lidMapping.getPNForLID(peer + '@lid'))) {
                        jid = peer + '@lid';
                    }
                    messages.push({
                        key: { id: message.id, remoteJid: jid, fromMe },
                        messageTimestamp: message.timestamp
                    });
                }
                while (this.dbLock) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                await this.storeHistory(messages);
                this.db.exec(`
                    UPDATE history_chats SET complete = 0, last_attempt = 0,
                        oldest_key = (SELECT message_key FROM history_messages WHERE jid = history_chats.jid
                            ORDER BY timestamp DESC LIMIT 1),
                        oldest_timestamp = (SELECT timestamp FROM history_messages WHERE jid = history_chats.jid
                            ORDER BY timestamp DESC LIMIT 1)
                    WHERE EXISTS (SELECT 1 FROM history_messages WHERE jid = history_chats.jid)
                `);
            }
            // A lost cached message invalidates completion, including gaps inside a conversation.
            let gaps = this.db
                .prepare(
                    `
                SELECT DISTINCT jid FROM history_messages h
                WHERE stored = 1 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = h.id)
            `
                )
                .all();
            for (let { jid } of gaps) {
                let latest = this.db
                    .prepare(
                        `
                    SELECT message_key, timestamp FROM history_messages WHERE jid = ? ORDER BY timestamp DESC LIMIT 1
                `
                    )
                    .get(jid);
                this.db
                    .prepare(
                        `
                    UPDATE history_chats SET complete = 0, oldest_key = ?, oldest_timestamp = ?, last_attempt = 0
                    WHERE jid = ?
                `
                    )
                    .run(latest.message_key, latest.timestamp, jid);
            }
            let chats = this.db
                .prepare(
                    `
                SELECT * FROM history_chats WHERE complete = 0 AND oldest_key IS NOT NULL AND last_attempt <= ?
                ORDER BY last_attempt, jid
            `
                )
                .all(Date.now() - wahelperDaemon.HISTORY_RETRY_DELAY);
            for (let chat of chats) {
                while (this.sock === socket && this.connected && chat.complete === 0) {
                    this.db
                        .prepare('UPDATE history_chats SET last_attempt = ?, last_error = NULL WHERE jid = ?')
                        .run(Date.now(), chat.jid);
                    let timeout;
                    let response = new Promise(resolve => {
                        let request = {
                            id: null,
                            received: [],
                            resolve,
                            onHistory: result => {
                                if (request.id === null) {
                                    request.received.push(result);
                                    return;
                                }
                                if (result.peerDataRequestSessionId === request.id) {
                                    clearTimeout(timeout);
                                    if (!result.notification) {
                                        resolve(result);
                                    }
                                }
                            }
                        };
                        this.historyRequest = request;
                        timeout = setTimeout(
                            () => resolve({ error: 'history_request_timeout' }),
                            wahelperDaemon.HISTORY_REQUEST_TIMEOUT
                        );
                    });
                    try {
                        let key = JSON.parse(chat.oldest_key);
                        if (key.remoteJid.endsWith('@s.whatsapp.net')) {
                            let lid = await socket.signalRepository.lidMapping.getLIDForPN(key.remoteJid);
                            if (lid) {
                                key.remoteJidAlt = key.remoteJid;
                                key.remoteJid = jidNormalizedUser(lid);
                            }
                        }
                        this.historyRequest.id = await socket.fetchMessageHistory(50, key, chat.oldest_timestamp);
                        for (let result of this.historyRequest.received) {
                            this.historyRequest.onHistory(result);
                        }
                        let result = await response;
                        if (result.error) {
                            throw new Error(result.error);
                        }
                        // A correlated, finished empty page exhausts the history currently available from the phone.
                        if (result.progress === 100 && result.messages.length === 0 && result.chats.length === 0) {
                            this.db
                                .prepare('UPDATE history_chats SET complete = 1, last_error = NULL WHERE jid = ?')
                                .run(chat.jid);
                        }
                        let next = this.db.prepare('SELECT * FROM history_chats WHERE jid = ?').get(chat.jid);
                        if (!next) {
                            break;
                        }
                        if (
                            next.complete &&
                            this.db
                                .prepare(
                                    `
                            SELECT 1 FROM history_messages h WHERE jid = ? AND stored = 1
                                AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = h.id) LIMIT 1
                        `
                                )
                                .get(chat.jid)
                        ) {
                            this.db.prepare('UPDATE history_chats SET complete = 0 WHERE jid = ?').run(chat.jid);
                            throw new Error('history_gap_unresolved');
                        }
                        if (!next.complete && next.oldest_key === chat.oldest_key) {
                            throw new Error('history_response_without_older_messages_or_completion');
                        }
                        chat = next;
                    } catch (error) {
                        this.history.lastError = error.message;
                        this.db
                            .prepare('UPDATE history_chats SET last_error = ? WHERE jid = ?')
                            .run(error.message, chat.jid);
                        break;
                    } finally {
                        clearTimeout(timeout);
                        this.historyRequest = null;
                    }
                }
            }
        } catch (error) {
            this.history.lastError = error.message;
            this.log('History sync failed: ' + error.message);
        } finally {
            this.history.running = false;
            if (
                this.connected &&
                this.dbIsOpen &&
                this.db.prepare(`
                    SELECT 1 FROM history_chats WHERE complete = 0 AND oldest_key IS NOT NULL
                        AND last_attempt = 0 LIMIT 1
                `).get()
            ) {
                void this.syncHistory();
            }
        }
    }

    async storeHistoryBatch(obj) {
        this.log('messaging-history.set', {
            syncType: obj.syncType,
            progress: obj.progress,
            messages: obj.messages.length,
            transfers: obj.chats.map(chat => ({ end: chat.endOfHistoryTransfer, type: chat.endOfHistoryTransferType }))
        });
        let stored = await this.storeDataToDatabase(obj);
        if (obj.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
            this.historyRequest?.onHistory({ ...obj, error: stored === false ? 'history_storage_failed' : null });
        }
        this.isFirstRun = false;
        void this.syncHistory();
    }

    // mark messages as read based on two signals that baileys ships with
    // history-sync and chats.upsert payloads:
    //   1. message.status === READ (=4, sometimes serialised as "READ") —
    //      the WA server already knows this message was seen on some device
    //   2. chat.unreadCount === 0 — the user has opened that chat on the
    //      phone, so every incoming message there is implicitly seen
    //   3. chat.unreadCount === -1 — represent a manual unread marker on
    //      the latest incoming message, not on the entire conversation
    async applyReadFlags(messages, chats) {
        let device = this.args.device || 'me';
        let byStatus = this.db.prepare('UPDATE messages SET `read` = 1 WHERE id = ? AND `read` = 0');
        let byChat = this.db.prepare(
            'UPDATE messages SET `read` = 1 WHERE `read` = 0 AND ((`from` = ? AND `to` = ?) OR (`to` = ? AND `from` != ?))'
        );
        let byChatUnread = this.db.prepare(`
            UPDATE messages SET \`read\` = 0 WHERE \`read\` = 1 AND id = (
                SELECT id FROM messages WHERE \`from\` != $device
                AND ((\`from\` IN ($primary, $alternate) AND \`to\` = $device) OR \`to\` IN ($primary, $alternate))
                ORDER BY timestamp DESC, rowid DESC LIMIT 1
            )
        `);

        let touchedStatus = 0;
        for (let m of messages) {
            let s = m?.status;
            if (s !== 4 && s !== '4' && s !== 'READ') continue;
            let id = m?.key?.id;
            if (!id) continue;
            let r = byStatus.run(id);
            if (r?.changes) touchedStatus += r.changes;
        }

        let touchedChat = 0;
        let touchedUnread = 0;
        for (let c of chats) {
            if (c?.unreadCount !== 0 && c?.unreadCount !== -1) continue;
            let jid = jidNormalizedUser(c?.id ?? '');
            let identifiers = new Set([jidDecode(jid)?.user]);
            if (jid.endsWith('@lid')) {
                let phone = await this.sock?.signalRepository?.lidMapping?.getPNForLID(jid);
                identifiers.add(jidDecode(phone)?.user);
            }
            if (c.unreadCount === -1) {
                let [primary, alternate = primary] = [...identifiers].filter(Boolean);
                if (!primary) continue;
                touchedUnread += byChatUnread.run({ device, primary, alternate }).changes;
                continue;
            }
            for (let identifier of identifiers) {
                if (!identifier) continue;
                let result = byChat.run(identifier, device, identifier, device);
                if (result?.changes) touchedChat += result.changes;
            }
        }

        if (touchedStatus > 0 || touchedChat > 0 || touchedUnread > 0) {
            this.log(`read flags: ${touchedStatus} via status, ${touchedChat} via chat, ${touchedUnread} manually unread`);
        }
    }

    async markMessagesRead(updates) {
        if (!Array.isArray(updates) || updates.length === 0) {
            return;
        }
        // WAMessageStatus.READ === 4
        let ids = updates
            .filter(u => u?.update?.status === 4)
            .map(u => u?.key?.id)
            .filter(id => typeof id === 'string' && id.length > 0);
        if (ids.length === 0) {
            return;
        }
        while (this.dbLock) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        this.dbLock = true;
        try {
            if (this.dbIsOpen === false) {
                this.initDatabase();
            }
            let stmt = this.db.prepare('UPDATE messages SET `read` = 1 WHERE id = ? AND `read` = 0');
            let touched = 0;
            for (let id of ids) {
                let res = stmt.run(id);
                if (res && res.changes > 0) touched++;
            }
            if (touched > 0) {
                this.log('marked ' + touched + '/' + ids.length + ' messages as read');
            }
        } catch (error) {
            this.log('⛔ markMessagesRead failed: ' + error.message);
        } finally {
            this.dbLock = false;
        }
    }

    async markChatsRead(updates) {
        // baileys fires chats.update with `unreadCount: 0` when an EXISTING chat
        // is opened on the phone. unlike messages.update (status=4 read receipt),
        // this also covers GROUPS, which usually ship no read receipts — without
        // it their incoming messages would stay `read = 0` forever even after the
        // user has clearly seen them (e.g. reacted with an emoji).
        if (!Array.isArray(updates) || updates.length === 0) {
            return;
        }
        let chats = updates.filter(c => c?.unreadCount === 0 || c?.unreadCount === -1);
        if (chats.length === 0) {
            return;
        }
        while (this.dbLock) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        this.dbLock = true;
        try {
            if (this.dbIsOpen === false) {
                this.initDatabase();
            }
            await this.applyReadFlags([], chats);
        } catch (error) {
            this.log('⛔ markChatsRead failed: ' + error.message);
        } finally {
            this.dbLock = false;
        }
    }

    async sendMessageToUser(number = null, message = null, attachments = null) {
        if (!this.getStatus().connected) {
            throw new Error(this.loggedOut ? 'logged_out' : 'not_connected');
        }
        // validate all attachments exist before sending anything
        if (attachments !== null && attachments.length > 0) {
            for (let attachments__value of attachments) {
                if (!fs.existsSync(attachments__value)) {
                    throw new Error('Attachment file not found: ' + attachments__value);
                }
            }
        }
        let jid = this.formatNumber(number) + '@s.whatsapp.net',
            msgResponse = [];
        this.log('begin send message to user ' + jid);
        msgResponse.push(await this.sock.sendMessage(jid, { text: this.formatMessage(message) }));
        this.log('end send message to user ' + jid);
        //this.log(attachments);
        if (attachments !== null && attachments.length > 0) {
            for (let attachments__value of attachments) {
                msgResponse.push(await this.sock.sendMessage(jid, this.getAttachmentObj(attachments__value)));
            }
        }
        return msgResponse;
    }

    async sendMessageToGroup(name = null, message = null, attachments = null) {
        if (!this.getStatus().connected) {
            throw new Error(this.loggedOut ? 'logged_out' : 'not_connected');
        }
        // validate all attachments exist before sending anything
        if (attachments !== null && attachments.length > 0) {
            for (let attachments__value of attachments) {
                if (!fs.existsSync(attachments__value)) {
                    throw new Error('Attachment file not found: ' + attachments__value);
                }
            }
        }
        let jid = null,
            msgResponse = [],
            groups = await this.sock.groupFetchAllParticipating();
        for (let groups__value of Object.values(groups)) {
            if (groups__value.subject === name) {
                jid = groups__value.id;
                break;
            }
        }
        if (jid !== null) {
            msgResponse.push(await this.sock.sendMessage(jid, { text: this.formatMessage(message) }));
            if (attachments !== null && attachments.length > 0) {
                for (let attachments__value of attachments) {
                    msgResponse.push(await this.sock.sendMessage(jid, this.getAttachmentObj(attachments__value)));
                }
            }
        }
        return msgResponse;
    }

    connect() {
        if (this.connecting || this.loggedOut) {
            return;
        }
        this.connecting = true;
        let connectionAttempt = Symbol('connection');
        let socket = null;
        let staleSocket = null;
        let connectionTimeoutError = new Error('connection attempt timed out');
        this.connectionAttempt = connectionAttempt;
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = setTimeout(() => {
            if (this.connectionAttempt !== connectionAttempt || this.connected) {
                return;
            }
            this.connectionTimeout = null;
            this.connected = false;
            this.connecting = false;
            this.lastError = { source: 'connect', message: connectionTimeoutError.message, at: Date.now() };
            this.log('⛔ Connect error: ' + connectionTimeoutError.message);
            console.log('⛔ Connect error: ' + connectionTimeoutError.message);
            let socketToClose = socket || staleSocket || this.sock;
            if (socketToClose) {
                void socketToClose.end(connectionTimeoutError);
            }
            setTimeout(() => {
                if (
                    this.connectionAttempt !== connectionAttempt ||
                    this.connected ||
                    this.connecting
                ) {
                    return;
                }
                if (this.sock === socketToClose) {
                    this.sock = null;
                }
                this.connect();
            }, this.reconnectDelay);
        }, 60000);
        this.log('Connecting...');
        console.log('Connecting...');

        useMultiFileAuthState(this.dirname + '/' + this.authFolder)
            .then(async ({ state, saveCreds }) => {
                if (this.connectionAttempt !== connectionAttempt) {
                    return;
                }
                let { version } = await fetchLatestBaileysVersion();
                if (this.connectionAttempt !== connectionAttempt) {
                    return;
                }
                console.log('Baileys version: ' + version.join('.'));

                // close stale socket if present
                staleSocket = this.sock;
                this.sock = null;
                if (staleSocket) {
                    try {
                        await staleSocket.end();
                    } catch (_) {}
                }
                if (this.connectionAttempt !== connectionAttempt) {
                    return;
                }

                console.log('Creating WebSocket...');
                socket = makeWASocket({
                    auth: state,
                    logger: P({ level: 'silent' }, P.destination(2)),
                    syncFullHistory: true,
                    shouldSyncHistoryMessage: () => true,
                    version,
                    browser: Browsers.windows('Desktop')
                });
                this.sock = socket;
                staleSocket = null;

                socket.ev.on('messaging-history.set', async obj => {
                    if (obj.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
                        return;
                    }
                    await this.storeHistoryBatch(obj);
                });

                socket.ev.on('messages.upsert', async obj => {
                    this.log('messages.upsert');
                    for (let message of obj.messages) {
                        let notification = getHistoryMsg(message.message);
                        if (notification?.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
                            this.historyRequest?.onHistory({
                                peerDataRequestSessionId: notification.peerDataRequestSessionId,
                                notification: true
                            });
                        }
                    }
                    await this.storeDataToDatabase(obj);
                    for (let message of obj.messages) {
                        let notification = getHistoryMsg(message.message);
                        if (notification?.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND) {
                            continue;
                        }
                        try {
                            // Baileys' event buffer removes previously seen history messages and chat completion flags.
                            let history = await downloadAndProcessHistorySyncNotification(notification, {
                                signal: AbortSignal.timeout(wahelperDaemon.HISTORY_REQUEST_TIMEOUT)
                            });
                            if (this.sock !== socket) {
                                continue;
                            }
                            await this.storeHistoryBatch({
                                ...history,
                                peerDataRequestSessionId: notification.peerDataRequestSessionId
                            });
                        } catch (error) {
                            this.historyRequest?.onHistory({
                                peerDataRequestSessionId: notification.peerDataRequestSessionId,
                                error: 'history_download_failed'
                            });
                        }
                    }
                    void this.syncHistory();
                });

                socket.ev.on('chats.upsert', async obj => {
                    this.log('chats.upsert');
                    await this.storeDataToDatabase(obj);
                });

                socket.ev.on('messages.update', async updates => {
                    try {
                        await this.storeDataToDatabase({ updates });
                        await this.markMessagesRead(updates);
                    } catch (error) {
                        this.log('⛔ messages.update handler failed: ' + error.message);
                    }
                });

                socket.ev.on('chats.update', async updates => {
                    try {
                        await this.markChatsRead(updates);
                    } catch (error) {
                        this.log('⛔ chats.update handler failed: ' + error.message);
                    }
                });

                socket.ev.on('creds.update', saveCreds);

                socket.ev.on('connection.update', async update => {
                    if (this.sock !== socket) {
                        return;
                    }
                    let { connection, lastDisconnect, qr } = update;
                    let statusCode = lastDisconnect?.error?.output?.statusCode;
                    this.log(connection);

                    if (qr) {
                        // the socket is alive and waits for the user to link the device
                        clearTimeout(this.connectionTimeout);
                        this.connectionTimeout = null;
                        this.isFirstRun = true;
                        if (USE_PAIRING_CODE) {
                            // request pairing code once per session
                            if (!this.pairingCodeRequested && this.device) {
                                this.pairingCodeRequested = true;
                                socket
                                    .requestPairingCode(this.device)
                                    .then(code => {
                                        if (this.sock !== socket) {
                                            return;
                                        }
                                        this.pairingCode = code;
                                        console.log('\nPairing code: ' + code);
                                    })
                                    .catch(err => {
                                        if (this.sock !== socket) {
                                            return;
                                        }
                                        this.lastError = { source: 'pairing', message: err.message, at: Date.now() };
                                        this.log('Pairing code request failed: ' + err.message);
                                    });
                            }
                        } else {
                            // use QR code
                            this.qr = qr;
                            qrcodeTerminal.generate(qr, { small: true }, qrString => {
                                console.log('\nScan this QR code with WhatsApp:');
                                console.log(qrString);
                            });
                        }
                    } else {
                        if (connection === 'close') {
                            clearTimeout(this.connectionTimeout);
                            this.connectionTimeout = null;
                            this.connectionAttempt = null;
                            this.connected = false;
                            this.connecting = false;
                            this.historyRequest?.resolve({ error: 'connection_closed' });

                            if (statusCode === DisconnectReason.restartRequired) {
                                // normal after requestPairingCode() — reconnect immediately, keep pairing code
                                this.log('Restart required, reconnecting...');
                                this.connect();
                                return;
                            }

                            if (statusCode === DisconnectReason.loggedOut) {
                                this.loggedOut = true;
                                this.sock = null;
                                this.qr = null;
                                this.pairingCode = null;
                                this.pairingCodeRequested = false;
                                this.lastError = {
                                    source: 'disconnect',
                                    message: 'Logged out. Automatic reconnect stopped; manual device linking required.',
                                    statusCode,
                                    at: Date.now()
                                };
                                this.log(this.lastError);
                                console.error(this.lastError.message);
                                return;
                            }

                            // a disconnect right after a pairing failure is just
                            // the symptom — keep the more specific upstream
                            // reason (e.g. "rate-overlimit") instead of burying
                            // it under a generic "connectionLost"
                            if (lastDisconnect?.error === connectionTimeoutError) {
                                this.lastError = {
                                    source: 'connect',
                                    message: connectionTimeoutError.message,
                                    at: Date.now()
                                };
                            } else if (this.lastError?.source !== 'pairing') {
                                let reason =
                                    DisconnectReason && statusCode
                                        ? Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusCode)
                                        : null;
                                this.lastError = {
                                    source: 'disconnect',
                                    message:
                                        'connection closed' +
                                        (reason
                                            ? ' (' + reason + ')'
                                            : statusCode
                                              ? ' (statusCode=' + statusCode + ')'
                                              : ''),
                                    statusCode,
                                    at: Date.now()
                                };
                            }
                            this.log(this.lastError);
                            this.consecutiveFailures++;
                            // first 3 attempts recover network blips fast (1s/2s/4s),
                            // after that back off to 15min so a persistent failure
                            // (rate-overlimit, bad auth) doesn't keep hammering whatsapp
                            let cap = this.consecutiveFailures > 3 ? 15 * 60 * 1000 : 30000;
                            let delay = this.reconnectDelay;
                            this.log('Reconnecting in ' + delay + 'ms (attempt ' + this.consecutiveFailures + ')');
                            console.log('Reconnecting in ' + delay + 'ms (attempt ' + this.consecutiveFailures + ')...');
                            setTimeout(() => {
                                this.reconnectDelay = Math.min(this.reconnectDelay * 2, cap);
                                this.connect();
                            }, delay);
                        }

                        if (connection === 'open') {
                            clearTimeout(this.connectionTimeout);
                            this.connectionTimeout = null;
                            this.connectionAttempt = null;
                            this.connected = true;
                            this.connecting = false;
                            this.qr = null;
                            this.pairingCode = null;
                            this.pairingCodeRequested = false;
                            this.lastError = null;
                            this.reconnectDelay = 1000;
                            this.consecutiveFailures = 0;
                            this.log('✅ Connected');
                            console.log('✅ Connected (device: ' + this.device + ')');
                            void this.syncHistory();
                        }
                    }
                });
            })
            .catch(error => {
                if (this.connectionAttempt !== connectionAttempt) {
                    return;
                }
                clearTimeout(this.connectionTimeout);
                this.connectionTimeout = null;
                this.connectionAttempt = null;
                this.connecting = false;
                this.lastError = { source: 'connect', message: error.message, at: Date.now() };
                this.log('⛔ Connect error: ' + error.message);
                console.log('⛔ Connect error: ' + error.message);
                setTimeout(() => this.connect(), this.reconnectDelay);
            });
    }

    getStatus() {
        let history = this.db
            .prepare(
                `
            SELECT COUNT(*) AS chats, COALESCE(SUM(complete), 0) AS completeChats,
                COALESCE(SUM(oldest_key IS NULL AND complete = 0), 0) AS chatsWithoutCursor,
                COALESCE(SUM(last_error IS NOT NULL), 0) AS failedChats FROM history_chats
        `
            )
            .get();
        let missing = this.db
            .prepare(
                `
            SELECT COUNT(*) AS missingMessages FROM history_messages h
            WHERE stored = 1 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = h.id)
        `
            )
            .get();
        return {
            success: true,
            connected: this.connected && this.sock?.ws?.isOpen === true,
            connecting: this.connecting,
            loggedOut: this.loggedOut,
            device: this.device,
            qr: this.qr,
            pairingCode: this.pairingCode,
            lastError: this.lastError,
            history: {
                ...this.history,
                ...history,
                ...missing,
                knownChatsComplete:
                    !this.history.running &&
                    history.chats > 0 &&
                    history.chats === history.completeChats &&
                    missing.missingMessages === 0
            }
        };
    }

    startHttpServer() {
        this.httpServer = http.createServer(async (req, res) => {
            // bound to 127.0.0.1 below — every request additionally has to
            // carry the per-device auth token (X-Wahelper-Token header) so
            // other local processes can't read pairing codes or send messages
            let body = '';
            req.on('data', chunk => {
                body += chunk;
            });
            req.on('end', async () => {
                let data = {};
                try {
                    if (body) {
                        data = JSON.parse(body);
                    }
                } catch (_) {}

                let url = req.url.split('?')[0];

                try {
                    if (req.method === 'GET' && url === '/status') {
                        if (!this.isAuthorized(req)) {
                            this.sendJsonResponse(res, 403, { success: false, message: 'forbidden' });
                            return;
                        }
                        this.sendJsonResponse(res, 200, this.getStatus());
                        return;
                    }

                    if (req.method === 'POST' && url === '/sync-history') {
                        if (!this.isAuthorized(req)) {
                            this.sendJsonResponse(res, 403, { success: false, message: 'forbidden' });
                            return;
                        }
                        void this.syncHistory();
                        this.sendJsonResponse(res, 200, this.getStatus());
                        return;
                    }

                    if (req.method === 'POST' && url === '/send-user') {
                        if (!this.isAuthorized(req)) {
                            this.sendJsonResponse(res, 403, { success: false, message: 'forbidden' });
                            return;
                        }
                        if (!data.number || !data.message) {
                            this.sendJsonResponse(res, 400, { success: false, message: 'missing_parameters' });
                            return;
                        }
                        let result = await this.sendMessageToUser(data.number, data.message, data.attachments || null);
                        this.sendJsonResponse(res, 200, {
                            success: true,
                            message: 'message_user_sent',
                            data: result
                        });
                        return;
                    }

                    if (req.method === 'POST' && url === '/send-group') {
                        if (!this.isAuthorized(req)) {
                            this.sendJsonResponse(res, 403, { success: false, message: 'forbidden' });
                            return;
                        }
                        if (!data.name || !data.message) {
                            this.sendJsonResponse(res, 400, { success: false, message: 'missing_parameters' });
                            return;
                        }
                        let result = await this.sendMessageToGroup(data.name, data.message, data.attachments || null);
                        this.sendJsonResponse(res, 200, {
                            success: true,
                            message: 'message_group_sent',
                            data: result
                        });
                        return;
                    }

                    this.sendJsonResponse(res, 404, { success: false, message: 'not_found' });
                } catch (error) {
                    this.log('⛔ HTTP handler error: ' + error.message);
                    this.sendJsonResponse(res, 500, { success: false, message: error.message });
                }
            });
        });

        this.httpServer.listen(this.port, '127.0.0.1', () => {
            this.log('HTTP server listening on 127.0.0.1:' + this.port);
        });

        this.httpServer.on('error', error => {
            this.log('⛔ HTTP server error: ' + error.message);
            console.error('HTTP server error:', error.message);
        });
    }

    sendJsonResponse(res, statusCode, data) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    initExitHooks() {
        process.on('uncaughtException', async (error, origin) => {
            this.log('uncaughtException');
            console.error('uncaughtException:', error.message);
        });
        process.on('unhandledRejection', async (reason, promise) => {
            this.log('unhandledRejection');
            this.log(JSON.stringify(reason, null, 2));
        });
        process.on('SIGINT', async () => {
            this.log('SIGINT');
            this.gracefulShutdown();
            process.exit(0);
        });
        process.on('SIGTERM', async () => {
            this.log('SIGTERM');
            this.gracefulShutdown();
            process.exit(0);
        });
        process.on('exit', code => {
            this.log('final exit');
            console.log('final exit');
        });
    }

    gracefulShutdown() {
        this.connected = false;
        this.historyRequest?.resolve({ error: 'daemon_stopped' });
        clearTimeout(this.connectionTimeout);
        this.connectionAttempt = null;
        this.connectionTimeout = null;
        if (this.sock) {
            try {
                this.sock.end();
            } catch (_) {}
        }
        if (this.httpServer) {
            this.httpServer.close();
        }
        if (this.db && this.dbIsOpen) {
            this.db.close();
            this.dbIsOpen = false;
        }
        this.log('Daemon stopped');
    }

    isAlreadyRunning() {
        return new Promise(resolve => {
            let req = http.request(
                {
                    host: '127.0.0.1',
                    port: this.port,
                    path: '/status',
                    method: 'GET',
                    headers: { 'X-Wahelper-Token': this.authToken }
                },
                res => {
                    // any HTTP answer (even 403 from a token mismatch with a
                    // stale token file we somehow lost) means another daemon
                    // is bound to the port — we don't want to start a second one
                    resolve(res.statusCode >= 200 && res.statusCode < 500);
                }
            );
            req.on('error', () => resolve(false));
            req.setTimeout(2000, () => {
                req.destroy();
                resolve(false);
            });
            req.end();
        });
    }

    async init() {
        if (!this.args.device) {
            console.error('Error: --device argument is required');
            process.exit(1);
        }

        if (await this.isAlreadyRunning()) {
            console.error(
                '⛔ Daemon already running for device ' +
                    this.device +
                    ' (socket: ' +
                    this.dirname +
                    '/' +
                    this.socketPath +
                    ')'
            );
            process.exit(1);
        }

        this.log('Daemon starting.. (device: ' + this.device + ', port: 127.0.0.1:' + this.port + ')');
        console.log('Daemon starting... (device: ' + this.device + ', port: 127.0.0.1:' + this.port + ')');

        this.initDatabase();
        this.initExitHooks();
        this.startHttpServer();
        this.connect();
    }
}

// Importing the class must not start the daemon or connect to WhatsApp.
if (
    process.argv[1] &&
    fs.existsSync(process.argv[1]) &&
    fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    let daemon = new wahelperDaemon();
    daemon.init();
}
