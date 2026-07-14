#!/usr/bin/env -S NODE_NO_WARNINGS=1 node

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion,
    Browsers
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
        this.qr = null;
        this.pairingCode = null;
        this.pairingCodeRequested = false;
        this.lastError = null;
        this.isFirstRun = false;
        this.reconnectDelay = 1000;
        this.consecutiveFailures = 0;
        this.httpServer = null;

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
        let chats = Array.isArray(data?.chats) ? data.chats : [];
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
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            for (let messages__value of messages) {
                let id = messages__value.key?.id,
                    chatId = messages__value.key?.remoteJid,
                    fromMe = messages__value.key?.fromMe ? 1 : 0,
                    timestamp = messages__value.messageTimestamp;

                if (timestamp !== undefined && timestamp !== null) {
                    timestamp = Number(timestamp);
                    if (isNaN(timestamp)) {
                        timestamp = Math.floor(Date.now() / 1000);
                    }
                } else {
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
                if (from === 'status') {
                    continue;
                }

                let content = null,
                    mediaFilename = null,
                    mediaData = null,
                    mediaBufferInput = null;

                if (messages__value.message?.conversation) {
                    content = messages__value.message.conversation;
                } else if (messages__value.message?.extendedTextMessage?.text) {
                    content = messages__value.message.extendedTextMessage.text;
                } else if (messages__value.message?.imageMessage) {
                    content = messages__value.message.imageMessage.caption || null;
                    mediaFilename = id + '.jpg';
                    mediaBufferInput = messages__value;
                } else if (messages__value.message?.stickerMessage) {
                    content = messages__value.message.stickerMessage.caption || null;
                    mediaFilename = id + '.webp';
                    mediaBufferInput = messages__value;
                } else if (messages__value.message?.videoMessage) {
                    content = messages__value.message.videoMessage.caption || null;
                    mediaFilename = id + '.mp4';
                    mediaBufferInput = messages__value;
                } else if (messages__value.message?.documentMessage) {
                    content = messages__value.message.documentMessage.caption || null;
                    mediaFilename = messages__value.message.documentMessage.fileName || id + '.bin';
                    mediaBufferInput = messages__value;
                } else if (messages__value.message?.documentWithCaptionMessage) {
                    content =
                        messages__value.message.documentWithCaptionMessage.message.documentMessage.caption || null;
                    mediaFilename =
                        messages__value.message.documentWithCaptionMessage.message.documentMessage.fileName ||
                        id + '.bin';
                    mediaBufferInput = messages__value.message.documentWithCaptionMessage;
                } else if (messages__value.message?.audioMessage) {
                    content = messages__value.message.audioMessage.caption || null;
                    mediaFilename = id + '.ogg';
                    mediaBufferInput = messages__value;
                } else {
                    continue;
                }

                // skip media download on first run (initial history sync after fresh pairing)
                if (this.isFirstRun) {
                    if (content === null || content === '') {
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
                        mediaData = mediaBufferInput?.url || null;
                        this.log('⚠️ Failed to download media: ' + error.message + '. Storing URL instead.');
                    }
                }

                query.run(id, from, to, content, mediaData, mediaFilename, timestamp);
                count++;

                if (length < 100 || count % 100 === 0) {
                    let percent = Math.round((count / length) * 100);
                    this.log('syncing progress: ' + percent + '%');
                    process.stdout.write('\r📥 Syncing messages... ' + count + '/' + length + ' (' + percent + '%)');
                }
            }

            this.applyReadFlags(messages, chats);

            this.db.exec('COMMIT');
            this.log('END TRANSACTION');
            if (count > 0) {
                this.log('Stored ' + count + ' new messages to database (' + length + ' total received)');
                process.stdout.write(
                    '\r✅ Stored ' +
                        count +
                        ' new messages to database (' +
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
        }

        this.dbLock = false;
    }

    // mark messages as read based on two signals that baileys ships with
    // history-sync and chats.upsert payloads:
    //   1. message.status === READ (=4, sometimes serialised as "READ") —
    //      the WA server already knows this message was seen on some device
    //   2. chat.unreadCount === 0 — the user has opened that chat on the
    //      phone, so every incoming message there is implicitly seen
    applyReadFlags(messages, chats) {
        let device = this.args.device || 'me';
        let byStatus = this.db.prepare('UPDATE messages SET `read` = 1 WHERE id = ? AND `read` = 0');
        let byChat = this.db.prepare(
            'UPDATE messages SET `read` = 1 WHERE `read` = 0 AND ((`from` = ? AND `to` = ?) OR (`to` = ? AND `from` != ?))'
        );

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
        for (let c of chats) {
            if (c?.unreadCount !== 0) continue;
            let cid = (c?.id ?? '').replace(/@.*$/, '');
            if (!cid) continue;
            let r = byChat.run(cid, device, cid, device);
            if (r?.changes) touchedChat += r.changes;
        }

        if (touchedStatus > 0 || touchedChat > 0) {
            this.log('marked read: ' + touchedStatus + ' via status, ' + touchedChat + ' via chat.unreadCount=0');
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
        let chats = updates.filter(c => c?.unreadCount === 0);
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
            this.applyReadFlags([], chats);
        } catch (error) {
            this.log('⛔ markChatsRead failed: ' + error.message);
        } finally {
            this.dbLock = false;
        }
    }

    async sendMessageToUser(number = null, message = null, attachments = null) {
        if (!this.connected || !this.sock) {
            throw new Error('not_connected');
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
        if (!this.connected || !this.sock) {
            throw new Error('not_connected');
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
        if (this.connecting) {
            return;
        }
        this.connecting = true;
        this.log('Connecting...');
        console.log('Connecting...');

        useMultiFileAuthState(this.dirname + '/' + this.authFolder)
            .then(async ({ state, saveCreds }) => {
                // WhatsApp rejected Platform.WEB (value 14) since 2026-02-24.
                // fetchLatestBaileysVersion() returns a version that triggers a 405 — use a fixed working version instead.
                // See: https://github.com/WhiskeySockets/Baileys/issues/2370
                let version = [2, 3000, 1033893291];
                console.log('Baileys version: ' + version.join('.'));

                // close stale socket if present
                if (this.sock) {
                    try {
                        this.sock.end();
                    } catch (_) {}
                }

                console.log('Creating WebSocket...');
                this.sock = makeWASocket({
                    auth: state,
                    logger: P({ level: 'silent' }, P.destination(2)),
                    // sync full history always — on pairing and reconnects
                    syncFullHistory: true,
                    version,
                    browser: Browsers.windows('Desktop')
                });

                this.sock.ev.on('messaging-history.set', async obj => {
                    this.log('messaging-history.set');
                    await this.storeDataToDatabase(obj);
                    // allow media downloads on all future syncs (reconnects)
                    this.isFirstRun = false;
                });

                this.sock.ev.on('messages.upsert', async obj => {
                    this.log('messages.upsert');
                    await this.storeDataToDatabase(obj);
                });

                this.sock.ev.on('chats.upsert', async obj => {
                    this.log('chats.upsert');
                    await this.storeDataToDatabase(obj);
                });

                this.sock.ev.on('messages.update', async updates => {
                    try {
                        await this.markMessagesRead(updates);
                    } catch (error) {
                        this.log('⛔ messages.update handler failed: ' + error.message);
                    }
                });

                this.sock.ev.on('chats.update', async updates => {
                    try {
                        await this.markChatsRead(updates);
                    } catch (error) {
                        this.log('⛔ chats.update handler failed: ' + error.message);
                    }
                });

                this.sock.ev.on('creds.update', saveCreds);

                this.sock.ev.on('connection.update', async update => {
                    let { connection, lastDisconnect, qr } = update;
                    let statusCode = lastDisconnect?.error?.output?.statusCode;
                    this.log(connection);

                    if (qr) {
                        this.isFirstRun = true;
                        if (USE_PAIRING_CODE) {
                            // request pairing code once per session
                            if (!this.pairingCodeRequested && this.device) {
                                this.pairingCodeRequested = true;
                                this.sock
                                    .requestPairingCode(this.device)
                                    .then(code => {
                                        this.pairingCode = code;
                                        console.log('\nPairing code: ' + code);
                                    })
                                    .catch(err => {
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
                            this.connected = false;
                            this.connecting = false;

                            if (statusCode === DisconnectReason.restartRequired) {
                                // normal after requestPairingCode() — reconnect immediately, keep pairing code
                                this.log('Restart required, reconnecting...');
                                this.connect();
                                return;
                            }

                            if (statusCode === DisconnectReason.loggedOut) {
                                // logged out — delete auth and reconnect
                                this.qr = null;
                                this.pairingCode = null;
                                this.pairingCodeRequested = false;
                                this.log('Logged out, removing auth folder');
                                console.log('Logged out, removing auth folder...');
                                if (fs.existsSync(this.dirname + '/' + this.authFolder)) {
                                    fs.rmSync(this.dirname + '/' + this.authFolder, { recursive: true, force: true });
                                }
                                setTimeout(() => this.connect(), 1000);
                                return;
                            }

                            // a disconnect right after a pairing failure is just
                            // the symptom — keep the more specific upstream
                            // reason (e.g. "rate-overlimit") instead of burying
                            // it under a generic "connectionLost"
                            if (this.lastError?.source !== 'pairing') {
                                let reason =
                                    DisconnectReason && statusCode
                                        ? Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusCode)
                                        : null;
                                this.lastError = {
                                    source: 'disconnect',
                                    message:
                                        'connection closed' +
                                        (reason ? ' (' + reason + ')' : statusCode ? ' (statusCode=' + statusCode + ')' : ''),
                                    at: Date.now()
                                };
                            }
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
                        }
                    }
                });
            })
            .catch(error => {
                this.connecting = false;
                this.lastError = { source: 'connect', message: error.message, at: Date.now() };
                this.log('⛔ Connect error: ' + error.message);
                console.log('⛔ Connect error: ' + error.message);
                setTimeout(() => this.connect(), this.reconnectDelay);
            });
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
                        this.sendJsonResponse(res, 200, {
                            success: true,
                            connected: this.connected,
                            device: this.device,
                            qr: this.qr,
                            pairingCode: this.pairingCode,
                            lastError: this.lastError
                        });
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

let daemon = new wahelperDaemon();
daemon.init();
