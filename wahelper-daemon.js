#!/usr/bin/env -S NODE_NO_WARNINGS=1 node

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion
} from 'baileys';
import P from 'pino';
import qrcodeTerminal from 'qrcode-terminal';

// set to false to use QR code instead
const USE_PAIRING_CODE = true;
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import http from 'http';
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
        this.isFirstRun = false;
        this.reconnectDelay = 1000;
        this.httpServer = null;

        if (this.args.device) {
            this.device = this.formatNumber(this.args.device);
            this.authFolder = 'auth_' + this.device;
            this.dbPath = 'whatsapp_' + this.device + '.sqlite';
            this.logPath = 'whatsapp_' + this.device + '.log';
            this.port = this.computePort(this.device);
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
                    timestamp INTEGER
                );
            `);
        } catch (error) {
            this.log('⛔ Error initing database: ' + error.message + ' (code: ' + error.code + ')');
        }
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

        if (!data.messages || data.messages.length === 0) {
            return;
        }

        // wait for any existing db operation to finish
        while (this.dbLock) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        this.dbLock = true;

        //this.log(data.messages);
        let count = 0,
            length = data.messages.length;

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

            for (let messages__value of data.messages) {
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

                let from = null;
                let to = null;
                if (fromMe) {
                    from = this.args.device || 'me';
                    to = chatId;
                } else if (chatId?.endsWith('@g.us')) {
                    if (messages__value?.participant) {
                        from = messages__value?.participant;
                    } else if (messages__value?.key?.participantAlt) {
                        from = messages__value?.key?.participantAlt;
                    }
                    to = chatId;
                } else {
                    from = chatId;
                    to = this.args.device || 'me';
                }

                if (from) {
                    from = from.replace(/@.*$/, '');
                }
                if (to) {
                    to = to.replace(/@.*$/, '');
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
                    browser: ['Chrome', 'Windows', '110.0.5481.177']
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

                            // reconnect on all other disconnect reasons with exponential backoff
                            let delay = this.reconnectDelay;
                            this.log('Reconnecting in ' + delay + 'ms');
                            console.log('Reconnecting in ' + delay + 'ms...');
                            setTimeout(() => {
                                this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
                                this.connect();
                            }, delay);
                        }

                        if (connection === 'open') {
                            this.connected = true;
                            this.connecting = false;
                            this.qr = null;
                            this.pairingCode = null;
                            this.pairingCodeRequested = false;
                            this.reconnectDelay = 1000;
                            this.log('✅ Connected');
                            console.log('✅ Connected (device: ' + this.device + ')');
                        }
                    }
                });
            })
            .catch(error => {
                this.connecting = false;
                this.log('⛔ Connect error: ' + error.message);
                console.log('⛔ Connect error: ' + error.message);
                setTimeout(() => this.connect(), this.reconnectDelay);
            });
    }

    startHttpServer() {
        this.httpServer = http.createServer(async (req, res) => {
            // Unix socket — only local processes can connect, no IP check needed

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
                        // trigger connect on first request
                        if (!this.connected && !this.connecting) {
                            this.connect();
                        }
                        this.sendJsonResponse(res, 200, {
                            success: true,
                            connected: this.connected,
                            device: this.device,
                            qr: this.qr,
                            pairingCode: this.pairingCode
                        });
                        return;
                    }

                    if (req.method === 'POST' && url === '/send-user') {
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
            let req = http.request({ host: '127.0.0.1', port: this.port, path: '/status', method: 'GET' }, res => {
                resolve(res.statusCode === 200);
            });
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
        // connect lazily on first incoming request
    }
}

let daemon = new wahelperDaemon();
daemon.init();
