#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    processSyncAction
} from 'baileys';
import P from 'pino';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';

export default class WhatsApp {
    constructor() {
        this.args = this.parseArgs();
        this.dirname = process.cwd() + '/whatsapp_data';
        // create dir if not exists
        if (!fs.existsSync(this.dirname)) {
            fs.mkdirSync(this.dirname, { recursive: true });
        }
        this.sock = null;
        this.locks = { db: false };
        this.db = null;
        this.dbIsOpen = false;
        this.shutdown = false;
        this.isFirstRun = false;
        this.isMcp = this.args.mcp === true;
        this.inactivityTimeMaxOrig = 10;
        this.inactivityTimeMax = this.inactivityTimeMaxOrig;
        this.inactivityTimeCur = 0;
        this.inactivityTimeInterval = null;
        this.inactivityTimeStatus = false;
        if (this.args.device !== undefined && this.args.device !== null && this.args.device !== '') {
            this.authFolder = 'auth_' + this.formatNumber(this.args.device);
            this.dbPath = 'whatsapp_' + this.formatNumber(this.args.device) + '.sqlite';
            this.logPath = 'whatsapp_' + this.formatNumber(this.args.device) + '.log';
            this.dataPath = 'whatsapp_' + this.formatNumber(this.args.device) + '.json';
        }
    }

    async init() {
        await this.awaitLock('init', true);
        this.setLock('init', true);
        this.write({ success: false, message: 'loading_state', data: null });

        if (this.isMcp === false) {
            this.log('cli start');
            this.log(this.args);
            if (
                this.args.device === undefined ||
                (this.args.action === 'send_user' &&
                    (this.args.number === undefined || this.args.message === undefined)) ||
                (this.args.action === 'send_group' &&
                    (this.args.name === undefined || this.args.message === undefined)) ||
                !['fetch_messages', 'send_user', 'send_group'].includes(this.args.action)
            ) {
                console.error('input missing or unknown action!');
                this.log('⛔input missing or unknown action!');
                this.write({
                    success: false,
                    message: 'error',
                    public_message: 'input missing or unknown action!',
                    data: null
                });
                this.removeLocks();
            } else {
                this.initDatabase();
                this.initInactivityTimer();
                this.initExitHooks();
                if (this.args.reset === true) {
                    this.resetFolder();
                }
                let response = null;
                if (this.args.action === 'fetch_messages') {
                    response = await this.authAndRun(() => this.fetchMessages());
                }
                if (this.args.action === 'send_user') {
                    response = await this.authAndRun(() =>
                        this.sendMessageToUser(this.args.number, this.args.message, this.args.attachments)
                    );
                }
                if (this.args.action === 'send_group') {
                    response = await this.authAndRun(() =>
                        this.sendMessageToGroup(this.args.name, this.args.message, this.args.attachments)
                    );
                }
                console.log(response);
                await this.endSession();
            }
            this.log('cli stop');
            //process.exit();
        }

        if (this.isMcp === true) {
            this.log('mcp start');
            this.registerMcp();
            let transport = new StdioServerTransport();
            await server.connect(transport);
            this.log('mcp stop');
        }
    }

    async endSession() {
        if (this.shutdown === true) {
            return;
        }
        this.shutdown = true;
        this.setInactivityTimeMax(0);

        // this mainly closes the websocket connection
        // be aware that the connecion cound be still active afterwards
        this.log('⏳sock.end');
        this.sock.end();
        this.log('✅sock.end');

        // we wait until the connection is really closed
        //await new Promise(resolve => setTimeout(resolve, 1000));

        if (this.db) {
            this.log('⏳db.close');
            this.db.close();
            this.dbIsOpen = false;
            this.log('✅db.close');
        }

        return;
        // this is too harsh
        //process.exit(0);
    }

    async authAndRun(fn) {
        return new Promise(async (resolve, reject) => {
            let { state, saveCreds } = await useMultiFileAuthState(this.dirname + '/' + this.authFolder);
            this.sock = makeWASocket({
                auth: state,
                logger: P(
                    {
                        level: 'silent' // or info
                    },
                    P.destination(2)
                ),
                syncFullHistory: true
            });
            /* this syncs on pairing / initial connection */
            this.sock.ev.on('messaging-history.set', async obj => {
                this.restartInactivityTimer();
                //this.log(obj);
                this.log('messaging-history.set');
                await this.storeDataToDatabase(obj);
            });
            /* this syncs the diff for every subsequent connection */
            this.sock.ev.on('messages.upsert', async obj => {
                this.restartInactivityTimer();
                //this.log(obj);
                this.log('messages.upsert');
                await this.storeDataToDatabase(obj);
            });
            /* ??? */
            this.sock.ev.on('chats.upsert', async obj => {
                this.restartInactivityTimer();
                //this.log(obj);
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
                    // increase inactivity timer on pairing
                    this.restartInactivityTimer();
                    this.setInactivityTimeMax(60);
                    if (!this.isMcp) {
                        //let code = await QRCode.toString(qr, { type: 'utf8' });
                        //console.log(code);
                        let code = await this.sock.requestPairingCode(this.formatNumber(this.args.device));
                        // format code XXXXXXX => XXXX-XXXX
                        code = code.match(/.{1,4}/g).join('-');
                        console.log('Bitte verknüpfe das neue Gerät und gib diesen Code ein:');
                        console.log(code);
                        this.write({ success: false, message: 'pairing_code_required', data: code });
                    }
                    if (this.isMcp) {
                        resolve({
                            content: [{ type: 'text', text: 'QR Code muss gescannt werden.' }]
                        });
                        return;
                    }
                } else {
                    if (connection === 'close') {
                        if (this.isMcp === false) {
                            // reconnect after pairing (needed!)
                            if (statusCode === DisconnectReason.restartRequired) {
                                // again: reset inactivity timer after pairing
                                this.restartInactivityTimer();
                                this.setInactivityTimeMax(this.inactivityTimeMaxOrig);
                                this.log('⚠️close: reconnect');
                                resolve(await this.authAndRun(fn));
                                return;
                            } else if (statusCode === 401) {
                                this.log('⚠️close: 2');
                                if (this.resetFolder() === true) {
                                    console.log('reset authentication. try again!');
                                }
                                resolve(await this.authAndRun(fn));
                                return;
                            } else {
                                this.log('⚠️close: 3');
                                resolve();
                                return;
                            }
                        }
                    }

                    if (connection === 'open') {
                        resolve(await fn());
                    }
                }
            });
        });
    }

    initExitHooks() {
        process.on('uncaughtException', async (error, origin) => {
            this.log('uncaughtException');
            await this.endSession();
            process.exit(1);
        });
        process.on('unhandledRejection', async (reason, promise) => {
            this.log('unhandledRejection');
            this.log(JSON.stringify(reason, null, 2));
            await this.endSession();
            process.exit(1);
        });
        process.on('SIGINT', async () => {
            this.log('SIGINT');
            await this.endSession();
            process.exit(0);
        });
        process.on('SIGTERM', async () => {
            this.log('SIGTERM');
            await this.endSession();
            process.exit(0);
        });
        process.on('exit', code => {
            this.removeLocks();
            this.log('final exit');
            console.log('final exit');
        });
    }

    async awaitLock(name = null, file_based = true) {
        if (file_based === false) {
            // check if object has property and property is true
            while (this.locks[name] === true) {
                this.log('lock is present!!! awaiting ' + name);
                await new Promise(resolve => setTimeout(() => resolve(), 1000));
            }
        } else {
            while (fs.existsSync(this.dirname + '/whatsapp' + (name !== null ? '-' + name : '') + '.lock')) {
                await new Promise(resolve => setTimeout(() => resolve(), 1000));
            }
        }
        return;
    }

    setLock(name = null, file_based = true) {
        if (file_based === false) {
            this.locks[name] = true;
            this.log('set lock ' + name);
        } else {
            if (!fs.existsSync(this.dirname + '/whatsapp' + (name !== null ? '-' + name : '') + '.lock')) {
                fs.writeFileSync(this.dirname + '/whatsapp' + (name !== null ? '-' + name : '') + '.lock', '');
            }
        }
    }

    removeLock(name = null, file_based = true) {
        if (file_based === false) {
            this.locks[name] = false;
            this.log('remove lock ' + name);
        } else {
            if (fs.existsSync(this.dirname + '/whatsapp' + (name !== null ? '-' + name : '') + '.lock')) {
                fs.rmSync(this.dirname + '/whatsapp' + (name !== null ? '-' + name : '') + '.lock', { force: true });
            }
        }
    }

    removeLocks() {
        this.locks = {};
        let files = fs.readdirSync(this.dirname);
        for (let files__value of files) {
            if (files__value.endsWith('.lock')) {
                this.log('remove lock ' + files__value);
                fs.rmSync(this.dirname + '/' + files__value, { force: true });
            }
        }
    }

    initInactivityTimer() {
        this.inactivityTimeCur = 0;
        this.inactivityTimeInterval = setInterval(() => {
            this.inactivityTimeCur++;
            this.log(this.inactivityTimeCur + '/' + this.inactivityTimeMax);
            if (this.inactivityTimeStatus === false && this.inactivityTimeCur >= this.inactivityTimeMax) {
                if (this.inactivityTimeInterval) {
                    clearInterval(this.inactivityTimeInterval);
                }
                this.log('No new messages!');
                this.inactivityTimeStatus = true;
            }
        }, 1000);
    }

    restartInactivityTimer() {
        this.inactivityTimeCur = 0;
    }

    setInactivityTimeMax(s) {
        this.inactivityTimeMax = s;
    }

    async awaitInactivityTimer() {
        while (this.inactivityTimeStatus === false) {
            await new Promise(resolve => setTimeout(() => resolve(), 1000));
        }
        return;
    }

    async fetchMessages() {
        // wait for inactivity
        await this.awaitInactivityTimer();

        // fetch from database
        let messages = this.db
            .prepare(
                `
                    SELECT id, \`from\`, \`to\`, content, media_filename, timestamp
                    FROM messages
                    ORDER BY timestamp DESC
                `
            )
            .all();
        this.write({ success: true, message: 'messages_fetched', data: messages });
        return {
            content: [
                {
                    type: 'text',
                    text: 'Fetched ' + messages.length + ' messages from database'
                }
            ],
            structuredContent: messages
        };
    }

    formatMessage(message) {
        if (message === null || message === undefined || message === '') {
            return message;
        }
        // replace nbsp with spaces
        message = message.replace(/&nbsp;/g, ' ');
        // replace <br> with real line breaks
        message = message.replace(/<br\s*\/?>/gis, '\n');
        // replace " </x>" with "</x> "
        message = message.replace(/ (\<\/[a-z]+\>)/gis, '$1 ');
        // replace  "<x> " with " <x>"
        message = message.replace(/(\<[a-z]+(?:\s[^>]*)?\>) /gis, ' $1');
        // replace " \n" with "\n"
        message = message.replace(/ \n/gis, '\n');
        // remove "<x> </x>"
        message = message.replace(/<([a-z]+)(?:\s[^>]*)?\>\s*<\/\1>/gis, '');
        // replace <strong>...</strong> with "*"
        message = message.replace(/<strong(?:\s[^>]*)?\>(.*?)<\/strong>/gis, '*$1*');
        // replace <em></em> with "_"
        message = message.replace(/<em(?:\s[^>]*)?\>(.*?)<\/em>/gis, '_$1_');
        // replace <i></i> with "_"
        message = message.replace(/<i(?:\s[^>]*)?\>(.*?)<\/i>/gis, '_$1_');
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

    async sendMessageToUser(number = null, message = null, attachments = null) {
        let jid = this.formatNumber(number) + '@s.whatsapp.net',
            msgResponse = [];
        msgResponse.push(await this.sock.sendMessage(jid, { text: this.formatMessage(message) }));
        //this.log(attachments);
        if (attachments !== null && attachments.length > 0) {
            for (let attachments__value of attachments) {
                msgResponse.push(await this.sock.sendMessage(jid, this.getAttachmentObj(attachments__value)));
            }
        }
        this.write({ success: true, message: 'message_user_sent', data: msgResponse });
        //this.log(msgResponse);
        return {
            content: [{ type: 'text', text: JSON.stringify(msgResponse, null, 2) }],
            structuredContent: msgResponse
        };
    }

    async sendMessageToGroup(name = null, message = null, attachments = null) {
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
        this.write({ success: true, message: 'message_group_sent', data: msgResponse });
        //this.log(msgResponse);
        return {
            content: [{ type: 'text', text: JSON.stringify(msgResponse, null, 2) }],
            structuredContent: msgResponse
        };
    }

    registerMcp() {
        let server = new McpServer({
            name: 'whatsapp-mcp',
            version: '1.0.0'
        });

        server.registerTool(
            'fetch_messages',
            {
                title: 'Fetch messages',
                description: 'Fetch all messages',
                inputSchema: {},
                outputSchema: { result: z.string().describe('Result of fetching messages') }
            },
            async ({}) => {
                let response = await this.authAndRun(() => fetchMessages());
                return response;
            }
        );

        server.registerTool(
            'send_group',
            {
                title: 'Send message to group',
                description: 'Send message to group',
                inputSchema: { group: z.string().describe('Group name'), text: z.string().describe('Message text') },
                outputSchema: { result: z.string().describe('Result of sending message') }
            },
            async ({ group, text }) => {
                this.log([group, text]);
                let response = await this.authAndRun(() => sendMessageToGroup(group, text));
                return response;
            }
        );

        server.registerTool(
            'send_message',
            {
                title: 'Send message to person',
                description: 'Send message to person',
                inputSchema: {
                    number: z.string().describe('Person number'),
                    text: z.string().describe('Message text')
                },
                outputSchema: { result: z.string().describe('Result of sending message') }
            },
            async ({ number, text }) => {
                this.log([number, text]);
                let response = await this.authAndRun(() => sendMessageToPerson(number, text));
                return response;
            }
        );
    }

    formatNumber(number) {
        // replace leading zero with 49
        number = number.replace(/^0+/, '49');
        // remove non-digit characters
        number = number.replace(/\D/g, '');
        return number;
    }

    parseArgs() {
        let args = {};
        let argv = process.argv.slice(2);
        for (let i = 0; i < argv.length; i++) {
            if (argv[i].startsWith('-')) {
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

                if (key === 'attachments') {
                    if (value === null || value === undefined || value === '' || typeof value !== 'string') {
                        continue;
                    }
                    value = value.split(',');
                }

                args[key] = value;
            }
        }
        return args;
    }

    resetFolder() {
        if (fs.existsSync(this.dirname + '/' + this.authFolder)) {
            fs.rmSync(this.dirname + '/' + this.authFolder, { recursive: true, force: true });
        }
        if (fs.existsSync(this.dirname + '/' + this.dbPath)) {
            if (this.db !== null) {
                this.db.close();
                this.dbIsOpen = false;
            }
            fs.rmSync(this.dirname + '/' + this.dbPath, { force: true });
            this.initDatabase();
        }
        return true;
    }

    log(...args) {
        if (this.logPath === undefined) {
            return;
        }
        let message = args.map(arg => (typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg)).join(' ');
        let logLine = new Date().toISOString() + ' - ' + message + '\n';
        fs.appendFileSync(this.dirname + '/' + this.logPath, logLine);
    }

    write(msg) {
        if (this.dataPath === undefined) {
            return;
        }
        fs.writeFileSync(this.dirname + '/' + this.dataPath, JSON.stringify(msg));
    }

    initDatabase() {
        try {
            this.db = new DatabaseSync(this.dirname + '/' + this.dbPath);
            this.dbIsOpen = true;
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

    async storeDataToDatabase(data) {
        if (!data.messages || data.messages.length === 0) {
            return;
        }

        if (this.locks['db'] !== true) {
            this.setLock('db', false);
        } else {
            await this.awaitLock('db', false);
            this.setLock('db', false);
        }

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
                // skip status messages
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
                    /*
                    content = '[Unsupported message type]';
                    this.log('[Unsupported message type]');
                    this.log(messages__value);
                    */
                }

                // don't sync media on first run
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
                        this.log(
                            '✅ Failed to download media: ' + error.message + '. Store URL ' + mediaData + ' instead.'
                        );
                    }
                }

                this.restartInactivityTimer();
                query.run(id, from, to, content, mediaData, mediaFilename, timestamp);

                count++;
                if (length < 100 || count % 100 === 0) {
                    this.log('syncing progress: ' + Math.round((count / length) * 100, 2) + '%');
                }
            }
            this.db.exec('COMMIT');
            this.log('END TRANSACTION');
            if (count > 0) {
                this.log('Stored ' + count + ' new messages to database (' + length + ' total received)');
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

        this.removeLock('db', false);
    }
}

let wa = new WhatsApp();
wa.init();
