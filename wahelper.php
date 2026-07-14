<?php
namespace vielhuber\wahelper;

use PhpMcp\Server\Attributes\McpTool;
use PhpMcp\Server\Attributes\Schema;

class wahelper
{
    private int $timeout = 180;

    /**
     * Fetches synchronized WhatsApp message history from the local SQLite cache.
     *
     * @param string $device WhatsApp device identifier (phone number)
     * @param int|null $limit Maximum number of messages to return (default: 100)
     * @return object Result object containing success status, message type, and data array with fetched messages
     */
    #[
        McpTool(
            name: 'fetch_messages',
            description: 'Fetches the synchronized WhatsApp history from the local sqlite cache for a device. Returns structured messages, newest first by default. Supports filtering by `from`, `to`, `message` (substring match on the body), `date_from` and `date_until` — same shape as mailhelper.fetch_mails. For a DM thread call once with {from: peer} and once with {to: peer}; for a group with {to: groupId} (every group message stores the group id as recipient).'
        )
    ]
    public function fetchMessages(
        #[
            Schema(
                definition: [
                    'description' =>
                        'WhatsApp device identifier (international phone number without leading zero), e.g. "491234567890" or 491234567890. Can be string or integer.',
                    'anyOf' => [['type' => 'string', 'minLength' => 6], ['type' => 'integer']]
                ]
            )
        ]
        string|int $device,
        #[
            Schema(
                type: 'object',
                properties: [
                    'from' => ['type' => 'string', 'description' => 'Exact sender phone number.'],
                    'to' => [
                        'type' => 'string',
                        'description' => 'Exact recipient — peer phone number for a DM or group id for a group.'
                    ],
                    'message' => ['type' => 'string', 'description' => 'Substring that must appear in the message body.'],
                    'date_from' => [
                        'type' => 'string',
                        'format' => 'date',
                        'description' => 'Inclusive lower date bound (YYYY-MM-DD or unix seconds).'
                    ],
                    'date_until' => [
                        'type' => 'string',
                        'format' => 'date',
                        'description' => 'Inclusive upper date bound (YYYY-MM-DD or unix seconds).'
                    ]
                ],
                additionalProperties: false
            )
        ]
        ?array $filter = null,
        #[
            Schema(type: 'integer', description: 'Maximum number of messages to return', minimum: 1, maximum: 10000)
        ]
        int|null $limit = 100,
        #[Schema(type: 'string', enum: ['asc', 'desc'], description: 'Sort order — defaults to desc (newest first).')]
        ?string $order = null
    ): object {
        return $this->run([
            'action' => 'fetch_messages',
            'device' => $device,
            'filter' => $filter !== null ? json_encode($filter) : null,
            'limit' => $limit,
            'order' => $order
        ]);
    }

    /**
     * Looks up a single WhatsApp message by id from the local SQLite cache.
     *
     * @param string $device WhatsApp device identifier (phone number)
     * @param string $id Message id as returned by fetch_messages
     * @return object Result object containing success status and the matching message row (or null if not found)
     */
    #[
        McpTool(
            name: 'view_message',
            description: 'Look up a single WhatsApp message by its id from the local sqlite cache. Returns the full row (from, to, content, media_filename, media_path, timestamp, read). When the message has an attachment, the bytes are decoded from the daemon\'s cache and written to disk under `/tmp/wahelper-output/<slot>/<filename>`; the absolute path is returned as `media_path` so downstream tools (pdfreader, excel, …) can read it directly — same shape as mailhelper.view_mail attachments.'
        )
    ]
    public function viewMessage(
        #[
            Schema(
                definition: [
                    'description' =>
                        'WhatsApp device identifier (international phone number without leading zero), e.g. "491234567890" or 491234567890. Can be string or integer.',
                    'anyOf' => [['type' => 'string', 'minLength' => 6], ['type' => 'integer']]
                ]
            )
        ]
        string|int $device,
        #[Schema(type: 'string', description: 'Message id as returned by fetch_messages', minLength: 1)] string $id
    ): object {
        return $this->run([
            'action' => 'view_message',
            'device' => $device,
            'id' => $id
        ]);
    }

    /**
     * Sends a message with optional attachments to a WhatsApp user.
     *
     * @param string $device WhatsApp device identifier (phone number)
     * @param string $number Recipient phone number (international or national format)
     * @param string $message Message text (HTML allowed, will be converted to WhatsApp formatting)
     * @param array|null $attachments Optional array of absolute file paths to send as attachments
     * @return object Result object containing success status and message details
     */
    #[
        McpTool(
            name: 'send_user_message',
            description: 'Sends a message (and optional attachments) to a single WhatsApp contact number. HTML formatting is converted to WhatsApp markup.'
        )
    ]
    public function sendUser(
        #[
            Schema(
                definition: [
                    'description' =>
                        'WhatsApp device identifier (international phone number without leading zero), e.g. "491234567890" or 491234567890. Can be string or integer.',
                    'anyOf' => [['type' => 'string', 'minLength' => 6], ['type' => 'integer']]
                ]
            )
        ]
        string|int $device,
        #[
            Schema(
                definition: [
                    'description' =>
                        'Recipient phone number (international or national format), e.g. "491234567890", "015158754691", or 491234567890. Can be string or integer. Leading zeros are supported in string format.',
                    'anyOf' => [['type' => 'string', 'minLength' => 5], ['type' => 'integer']]
                ]
            )
        ]
        string|int $number,
        #[
            Schema(
                type: 'string',
                description: 'Message body (HTML allowed, converted to WhatsApp formatting)',
                minLength: 1
            )
        ]
        string $message,
        #[
            Schema(description: 'Optional array of absolute file paths to send as attachments')
        ]
        ?array $attachments = null
    ): object {
        return $this->run([
            'action' => 'send_user',
            'device' => $device,
            'number' => $number,
            'message' => $message,
            'attachments' => $attachments
        ]);
    }

    /**
     * Sends a message with optional attachments to a WhatsApp group.
     *
     * @param string $device WhatsApp device identifier (phone number)
     * @param string $name Exact WhatsApp group subject/name
     * @param string $message Message text (HTML allowed, will be converted to WhatsApp formatting)
     * @param array|null $attachments Optional array of absolute file paths to send as attachments
     * @return object Result object containing success status and message details
     */
    #[
        McpTool(
            name: 'send_group_message',
            description: 'Sends a formatted text (and optional attachments) to a WhatsApp group matched by its exact subject title. HTML formatting is converted to WhatsApp markup.'
        )
    ]
    public function sendGroup(
        #[
            Schema(
                definition: [
                    'description' =>
                        'WhatsApp device identifier (international phone number without leading zero), e.g. "491234567890" or 491234567890. Can be string or integer.',
                    'anyOf' => [['type' => 'string', 'minLength' => 6], ['type' => 'integer']]
                ]
            )
        ]
        string|int $device,
        #[Schema(type: 'string', description: 'Exact WhatsApp group subject/name', minLength: 1)] string $name,
        #[
            Schema(
                type: 'string',
                description: 'Message body (HTML allowed, converted to WhatsApp formatting)',
                minLength: 1
            )
        ]
        string $message,
        #[
            Schema(description: 'Optional array of absolute file paths to send as attachments')
        ]
        ?array $attachments = null
    ): object {
        return $this->run([
            'action' => 'send_group',
            'device' => $device,
            'name' => $name,
            'message' => $message,
            'attachments' => $attachments
        ]);
    }

    private function run(array $args): object
    {
        if (!isset($args['device']) || $args['device'] == '') {
            return (object) ['success' => false, 'message' => 'error', 'data' => null];
        }
        $args['device'] = $this->formatNumber((string) $args['device']);
        if (isset($args['number'])) {
            $args['number'] = $this->formatNumber((string) $args['number']);
        }
        $this->cleanup($args, true);
        $this->runInBackground($args);
        $return = $this->fetchReturn($args);
        $this->cleanup($args, false);
        return $return;
    }

    private function cleanup(array $args, bool $start = true): void
    {
        // create main folder if not exists
        if ($start === true) {
            if (!file_exists($this->getFolder())) {
                mkdir($this->getFolder(), 0755, true);
            }
        }
        if (file_exists($this->getFolder() . '/whatsapp_' . $args['device'] . '.json')) {
            unlink($this->getFolder() . '/whatsapp_' . $args['device'] . '.json');
        }
        if (file_exists($this->getFolder() . '/whatsapp_' . $args['device'] . '.bat')) {
            unlink($this->getFolder() . '/whatsapp_' . $args['device'] . '.bat');
        }
        if ($start === true) {
            if (file_exists($this->getFolder() . '/whatsapp.startup_' . $args['device'] . '.log')) {
                unlink($this->getFolder() . '/whatsapp.startup_' . $args['device'] . '.log');
            }
        }
    }

    private function runInBackground(array $args): void
    {
        $cli_args = trim(
            implode(
                ' ',
                array_map(
                    function ($args__key, $args__value) {
                        if (is_array($args__value)) {
                            $args__value = implode(',', $args__value);
                        }
                        return '--' .
                            str_replace('_', '-', $args__key) .
                            ' ' .
                            escapeshellarg((string) $args__value) .
                            '';
                    },
                    array_keys($args),
                    $args
                )
            )
        );

        if (strtoupper(substr(PHP_OS, 0, 3)) === 'WIN') {
            file_put_contents(
                $this->getFolder() . '/whatsapp_' . $args['device'] . '.bat',
                '@echo off' .
                    PHP_EOL .
                    'chcp 65001 >nul' .
                    PHP_EOL .
                    'cd /d ' .
                    $this->getFolder() .
                    '' .
                    PHP_EOL .
                    'start /B "" ' .
                    $this->getNodePath() .
                    ' --no-deprecation --disable-warning=ExperimentalWarning ' .
                    __DIR__ .
                    '/wahelper.js ' .
                    $cli_args .
                    ' >> ' .
                    $this->getFolder() .
                    '/whatsapp.startup_' .
                    $args['device'] .
                    '.log 2>&1'
            );
            pclose(popen('start /B cmd /c ' . $this->getFolder() . '/whatsapp_' . $args['device'] . '.bat', 'r'));
        } else {
            shell_exec(
                'cd ' .
                    $this->getFolder() .
                    ' && ' .
                    $this->getNodePath() .
                    ' --no-deprecation --disable-warning=ExperimentalWarning ' .
                    __DIR__ .
                    '/wahelper.js ' .
                    $cli_args .
                    ' >> ' .
                    $this->getFolder() .
                    '/whatsapp.startup_' .
                    $args['device'] .
                    '.log 2>&1 &'
            );
        }
    }

    private function fetchReturn(array $args): object
    {
        $return = (object) [];
        $timeout = $this->timeout;
        while (!property_exists($return, 'message') || $return->message === 'loading_state') {
            if (file_exists($this->getFolder() . '/whatsapp_' . $args['device'] . '.json')) {
                $return = json_decode(file_get_contents($this->getFolder() . '/whatsapp_' . $args['device'] . '.json'));
            }
            sleep(1);
            $timeout--;
            if ($timeout <= 0) {
                $return->success = false;
                $return->message = 'timeout_error';
                break;
            }
        }
        return $return;
    }

    private function getFolder(): string
    {
        $currentDir = __DIR__;
        if (strpos($currentDir, 'vendor') !== false) {
            $projectRoot = realpath($currentDir . '/../../../');
        } else {
            $projectRoot = $currentDir;
        }
        return $projectRoot . '/whatsapp_data';
    }

    private function getNodePath(): string
    {
        if (defined('NODE_PATH')) {
            return NODE_PATH;
        }
        $isWindows = strtoupper(substr(PHP_OS, 0, 3)) === 'WIN';
        $probeCmd = $isWindows ? 'where node 2>nul' : 'command -v node 2>/dev/null';
        $probed = trim((string) @shell_exec($probeCmd));
        $candidates = [];
        if ($probed !== '') {
            $candidates[] = explode("\n", str_replace("\r", '', $probed))[0];
        }
        if ($isWindows) {
            $candidates[] = 'C:\\Program Files\\nodejs\\node.exe';
            $candidates[] = 'C:\\Program Files (x86)\\nodejs\\node.exe';
            foreach (glob(($_SERVER['APPDATA'] ?? '') . '\\nvm\\v*\\node.exe') ?: [] as $path) {
                $candidates[] = $path;
            }
        } else {
            $candidates[] = '/usr/local/bin/node';
            $candidates[] = '/usr/bin/node';
            $candidates[] = '/opt/homebrew/bin/node';
            foreach (glob(($_SERVER['HOME'] ?? '/root') . '/.nvm/versions/node/*/bin/node') ?: [] as $path) {
                $candidates[] = $path;
            }
        }
        foreach ($candidates as $candidate) {
            if ($candidate !== '' && is_executable($candidate)) {
                return $candidate;
            }
        }
        return 'node';
    }

    private function formatNumber(string $number): string
    {
        // strip surrounding quotes that some LLMs inject (e.g. "\"491234567890\"")
        $number = trim($number, "\"' \t\n\r");
        // replace leading zero with 49
        $number = preg_replace('/^0+/', '49', $number);
        // remove non-digit characters
        $number = preg_replace('/\D/', '', $number);
        // if no country code present, prepend 49 (German default)
        if (!str_starts_with($number, '49')) {
            $number = '49' . $number;
        }
        return $number;
    }
}
