#!/usr/bin/env -S NODE_NO_WARNINGS=1 node

import http from 'http';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import qrcodeTerminal from 'qrcode-terminal';

export default class wahelper {
    constructor() {
        this.args = this.parseArgs();
        this.dirname = this.getDirname();
        // create dir if not exists
        if (!fs.existsSync(this.dirname)) {
            fs.mkdirSync(this.dirname, { recursive: true });
        }
        this.locks = { db: false };
        this.db = null;
        this.dbIsOpen = false;
        this.writeOnEnd = null;
        if (this.args.device !== undefined && this.args.device !== null && this.args.device !== '') {
            this.authFolder = 'auth_' + this.formatNumber(this.args.device);
            this.dbPath = 'whatsapp_' + this.formatNumber(this.args.device) + '.sqlite';
            this.logPath = 'whatsapp_' + this.formatNumber(this.args.device) + '.log';
            this.dataPath = 'whatsapp_' + this.formatNumber(this.args.device) + '.json';
            this.port = this.computePort(this.formatNumber(this.args.device));
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

    async init() {
        await this.awaitLock('init', true);
        this.setLock('init', true);
        this.write({ success: false, message: 'loading_state', data: null }, false);

        this.log('cli start');
        this.log(this.args);
        if (
            this.args.device === undefined ||
            (this.args.action === 'send_user' && (this.args.number === undefined || this.args.message === undefined)) ||
            (this.args.action === 'send_group' && (this.args.name === undefined || this.args.message === undefined)) ||
            (this.args.action === 'view_message' && (this.args.id === undefined || this.args.id === '')) ||
            (this.args.action === 'fetch_messages' &&
                this.args.limit !== undefined &&
                typeof this.args.limit !== 'number') ||
            !['fetch_messages', 'view_message', 'send_user', 'send_group'].includes(this.args.action)
        ) {
            console.error('input missing or unknown action!');
            this.log('⛔input missing or unknown action!');
            this.write(
                {
                    success: false,
                    message: 'error',
                    public_message: 'input missing or unknown action!',
                    data: null
                },
                true
            );
            this.removeLocks();
        } else {
            this.initDatabase();
            this.initExitHooks();
            if (this.args.reset === true) {
                this.resetFolder();
            }
            let response = null;
            let daemonStatus = await this.ensureDaemon();
            if (!daemonStatus.connected) {
                if (daemonStatus.message === 'daemon_not_running') {
                    console.log(
                        '⛔ Daemon not running. Start it with: npx wahelper-daemon --device ' + this.args.device
                    );
                }
                if (daemonStatus.message === 'pairing_required') {
                    console.log('\n⚠️  Pairing required. Enter this code in WhatsApp (Linked Devices), then retry.\n');
                    console.log('Pairing code: ' + daemonStatus.pairingCode);
                }
                if (daemonStatus.message === 'qr_required') {
                    console.log('\n⚠️  Pairing required. Scan the QR code with WhatsApp, then retry.\n');
                    console.log(daemonStatus.qrString);
                }
                this.write(
                    {
                        success: false,
                        message: daemonStatus.message,
                        data: daemonStatus.pairingCode || daemonStatus.qrString || null
                    },
                    true
                );
            } else {
                if (this.args.action === 'fetch_messages') {
                    response = await this.fetchMessages(this.args.limit);
                }
                if (this.args.action === 'view_message') {
                    response = await this.viewMessage(this.args.id);
                }
                if (this.args.action === 'send_user') {
                    response = await this.sendMessageToUser(this.args.number, this.args.message, this.args.attachments);
                }
                if (this.args.action === 'send_group') {
                    response = await this.sendMessageToGroup(this.args.name, this.args.message, this.args.attachments);
                }
            }
            if (this.db) {
                this.log('⏳db.close');
                this.db.close();
                this.dbIsOpen = false;
                this.log('✅db.close');
            }
        }
        this.log('cli stop');
    }

    async fetchMessages(limit = null) {
        // fetch directly from database — no connection to daemon needed
        try {
            let messages = this.db
                .prepare(
                    `
						SELECT id, \`from\`, \`to\`, content, media_filename, timestamp
						FROM messages
						ORDER BY timestamp DESC
						${limit !== null ? 'LIMIT ' + limit : ''}
					`
                )
                .all();
            console.log(
                'Fetched ' + messages.length + ' messages from database (' + this.dirname + '/' + this.dbPath + ').'
            );
            this.write({ success: true, message: 'messages_fetched', data: messages }, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Fetched ' + messages.length + ' messages from database'
                    }
                ],
                structuredContent: messages
            };
        } catch (error) {
            this.log('⛔ Error fetching database: ' + error.message + ' (code: ' + error.code + ')');
        }
        return null;
    }

    async viewMessage(id = null) {
        // lookup directly from database — no connection to daemon needed
        try {
            let message =
                this.db
                    .prepare(
                        `
							SELECT id, \`from\`, \`to\`, content, media_filename, timestamp
							FROM messages
							WHERE id = ?
							LIMIT 1
						`
                    )
                    .get(id) || null;
            if (message === null) {
                console.log('Message not found: ' + id);
                this.write({ success: false, message: 'message_not_found', data: null }, true);
                return { content: [{ type: 'text', text: 'Message not found: ' + id }], structuredContent: null };
            }
            console.log('Fetched message ' + id + ' from database.');
            this.write({ success: true, message: 'message_fetched', data: message }, true);
            return {
                content: [{ type: 'text', text: 'Fetched message ' + id }],
                structuredContent: message
            };
        } catch (error) {
            this.log('⛔ Error fetching message from database: ' + error.message + ' (code: ' + error.code + ')');
        }
        return null;
    }

    async sendMessageToUser(number = null, message = null, attachments = null) {
        let jid = this.formatNumber(number) + '@s.whatsapp.net';
        this.log('begin send message to user ' + jid);
        //this.log(attachments);
        let response = await this.callDaemon('POST', '/send-user', { number, message, attachments });
        this.log('end send message to user ' + jid);
        if (response.success) {
            console.log('✅ Message sent to ' + number + '.');
            this.write({ success: true, message: 'message_user_sent', data: response.data }, true);
        } else {
            console.log('⛔ Failed to send message to ' + number + ': ' + (response.message || 'error'));
            this.write({ success: false, message: response.message || 'error', data: null }, true);
        }
        //this.log(response.data);
        return {
            content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }],
            structuredContent: response.data
        };
    }

    async sendMessageToGroup(name = null, message = null, attachments = null) {
        let response = await this.callDaemon('POST', '/send-group', { name, message, attachments });
        if (response.success) {
            console.log('✅ Message sent to group "' + name + '".');
            this.write({ success: true, message: 'message_group_sent', data: response.data }, true);
        } else {
            console.log('⛔ Failed to send message to group "' + name + '": ' + (response.message || 'error'));
            this.write({ success: false, message: response.message || 'error', data: null }, true);
        }
        //this.log(response.data);
        return {
            content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }],
            structuredContent: response.data
        };
    }

    async ensureDaemon() {
        // check current status
        let status = await this.callDaemon('GET', '/status');

        // daemon not reachable — return error immediately, daemon must be started manually
        if (status.message === 'daemon_not_reachable') {
            return { connected: false, message: 'daemon_not_running' };
        }

        if (status.connected) {
            return status;
        }

        // poll up to 30s — return immediately when pairing code appears
        console.log('Waiting for daemon to connect...');
        for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            status = await this.callDaemon('GET', '/status');
            if (status.connected) {
                return status;
            }
            if (status.pairingCode) {
                return { connected: false, message: 'pairing_required', pairingCode: status.pairingCode };
            }
            if (status.qr) {
                // render QR to ASCII string for display
                let qrString = await new Promise(resolve => {
                    qrcodeTerminal.generate(status.qr, { small: true }, str => resolve('\n' + str));
                });
                return { connected: false, message: 'qr_required', qrString };
            }
        }

        return { connected: false, message: 'daemon_timeout' };
    }

    computePort(device) {
        // range 29000-31999: below linux ephemeral (32768+) and windows ephemeral (49152+)
        return 29000 + (parseInt(device.slice(-5)) % 3000);
    }

    async callDaemon(method, path, body = null) {
        return new Promise(resolve => {
            let postData = body !== null ? JSON.stringify(body) : '';
            let headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            };
            let options = { host: '127.0.0.1', port: this.port, path, method, headers };
            let req = http.request(options, res => {
                let data = '';
                res.on('data', chunk => {
                    data += chunk;
                });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (_) {
                        resolve({ success: false, message: 'invalid_daemon_response' });
                    }
                });
            });
            req.setTimeout(30000, () => {
                req.destroy();
                this.log('⛔ Daemon request timeout');
                resolve({ success: false, message: 'daemon_timeout' });
            });
            req.on('error', error => {
                this.log('⛔ Daemon connection error: ' + error.message);
                resolve({ success: false, message: 'daemon_not_reachable' });
            });
            req.write(postData);
            req.end();
        });
    }

    initExitHooks() {
        process.on('uncaughtException', async (error, origin) => {
            this.log('uncaughtException');
            if (this.db && this.dbIsOpen) {
                this.db.close();
                this.dbIsOpen = false;
            }
            process.exit(1);
        });
        process.on('unhandledRejection', async (reason, promise) => {
            this.log('unhandledRejection');
            this.log(JSON.stringify(reason, null, 2));
            if (this.db && this.dbIsOpen) {
                this.db.close();
                this.dbIsOpen = false;
            }
            process.exit(1);
        });
        process.on('SIGINT', async () => {
            this.log('SIGINT');
            if (this.db && this.dbIsOpen) {
                this.db.close();
                this.dbIsOpen = false;
            }
            process.exit(0);
        });
        process.on('SIGTERM', async () => {
            this.log('SIGTERM');
            if (this.db && this.dbIsOpen) {
                this.db.close();
                this.dbIsOpen = false;
            }
            process.exit(0);
        });
        process.on('exit', code => {
            if (this.writeOnEnd !== null) {
                this.write(this.writeOnEnd, false);
            }
            this.removeLocks();
            this.log('final exit');
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

                if (key === 'limit') {
                    value = parseInt(value);
                    if (!Number.isInteger(value)) {
                        continue;
                    }
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

    write(msg, writeOnEnd = true) {
        if (this.dataPath === undefined) {
            return;
        }
        if (writeOnEnd === true) {
            this.writeOnEnd = msg;
            return;
        }
        fs.writeFileSync(this.dirname + '/' + this.dataPath, JSON.stringify(msg));
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

    formatNumber(number) {
        // strip surrounding quotes that some LLMs inject
        number = String(number).replace(/^["'\s]+|["'\s]+$/g, '');
        // replace leading zero with 49
        number = number.replace(/^0+/, '49');
        // remove non-digit characters
        number = number.replace(/\D/g, '');
        // if no country code present, prepend 49 (German default)
        if (!number.startsWith('49')) {
            number = '49' + number;
        }
        return number;
    }
}

let wa = new wahelper();
wa.init()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
