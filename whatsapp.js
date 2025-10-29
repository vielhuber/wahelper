import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'baileys';
import P from 'pino';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';

export default class WhatsApp {
    constructor() {
        this.authFolder = 'auth';
        this.args = this.parseArgs();
        this.dirname = dirname(fileURLToPath(import.meta.url));
        this.isMcp = this.args.mcp === true;
        this.sock = null;
    }

    async init() {
        this.write({ success: false, message: 'loading_state', data: null });

        if (this.args.reset === true) {
            this.resetFolder();
        }

        if (this.isMcp === false) {
            this.log('cli start');
            console.log(this.args);
            if (
                this.args.own_number === undefined ||
                (this.args.action === 'send_user' &&
                    (this.args.number === undefined || this.args.message === undefined)) ||
                (this.args.action === 'send_group' &&
                    (this.args.name === undefined || this.args.message === undefined)) ||
                !['fetch_messages', 'send_user', 'send_group'].includes(this.args.action)
            ) {
                console.error('input missing or unknown action!');
                this.write({
                    success: false,
                    message: 'error',
                    public_message: 'input missing or unknown action!',
                    data: null
                });
            } else if (this.args.action === 'fetch_messages') {
                await this.authAndRun(() => this.fetchMessages());
                await this.endSession();
                //console.log(response);
            } else if (this.args.action === 'send_user') {
                await this.authAndRun(() => this.sendMessageToUser(this.args.number, this.args.message));
                await this.endSession();
                //console.log(response);
            } else if (this.args.action === 'send_group') {
                await this.authAndRun(() => this.sendMessageToGroup(this.args.name, this.args.message));
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
        // this works but takes very long
        /*
        console.log('sock.end');
        this.sock.end();
        */
        process.exit(0);
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
                )
            });
            this.sock.ev.on(
                'messaging-history.set',
                ({ chats: newChats, contacts: newContacts, messages: newMessages, syncType }) => {
                    this.log(newChats);
                }
            );
            this.sock.ev.on('creds.update', saveCreds);
            this.sock.ev.on('connection.update', async update => {
                let { connection, lastDisconnect, qr } = update;
                let statusCode = lastDisconnect?.error?.output?.statusCode;
                this.log(connection);

                if (qr) {
                    if (!this.isMcp) {
                        //let code = await QRCode.toString(qr, { type: 'utf8' });
                        //console.log(code);
                        let code = await this.sock.requestPairingCode(this.formatNumber(this.args.own_number));
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
                                resolve(await this.authAndRun(fn));
                                return;
                            } else if (statusCode === 401) {
                                if (this.resetFolder() === true) {
                                    console.log('reset authentication. try again!');
                                }
                                resolve(await this.authAndRun(fn));
                                return;
                            } else {
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

    async fetchMessages() {}

    async sendMessageToUser(number = null, message = null) {}

    async sendMessageToGroup(name = null, message = null) {
        // fetch all groups
        let response = await this.sock.groupFetchAllParticipating();
        //console.log(response);
        let msgResponse = null;
        for (let response__value of Object.values(response)) {
            if (response__value.subject === name) {
                msgResponse = await this.sock.sendMessage(response__value.id, { text: message });
                break;
            }
        }
        this.write({ success: true, message: 'successfully_finished', data: msgResponse });
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
            'fetch',
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
                let key = argv[i].replace(/^-+/, '').replace(/-/, '_'),
                    value = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : true;
                args[key] = value;
                if (value !== true) i++;
            }
        }
        return args;
    }

    resetFolder() {
        if (fs.existsSync(this.dirname + '/' + this.authFolder)) {
            fs.rmSync(this.dirname + '/' + this.authFolder, { recursive: true, force: true });
            return true;
        }
        return false;
    }

    log(...args) {
        let message = args.map(arg => (typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg)).join(' ');
        let logLine = `${new Date().toISOString()} - ${message}\n`;
        fs.appendFileSync(this.dirname + '/whatsapp.log', logLine);
    }

    write(msg) {
        fs.writeFileSync(this.dirname + '/whatsapp.json', JSON.stringify(msg));
    }
}

let wa = new WhatsApp();
wa.init();
