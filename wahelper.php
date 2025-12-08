<?php
namespace vielhuber\wahelper;

use PhpMcp\Server\Attributes\McpTool;
use PhpMcp\Server\Attributes\Schema;

class wahelper
{
    private $timeout = 180;

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
            description: 'Fetches the synchronized WhatsApp history from the local sqlite cache for a device. Returns structured messages, newest first. Requires the device to be paired once.'
        )
    ]
    public function fetchMessages(
        #[
            Schema(type: 'string', description: 'WhatsApp device identifier (international phone number)', minLength: 6)
        ]
        string $device,
        #[
            Schema(type: 'integer', description: 'Maximum number of messages to return', minimum: 1, maximum: 10000)
        ]
        int|null $limit = 100
    ) {
        return $this->run([
            'action' => 'fetch_messages',
            'device' => $device,
            'limit' => $limit
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
            Schema(type: 'string', description: 'WhatsApp device identifier (international phone number)', minLength: 6)
        ]
        string $device,
        #[
            Schema(
                type: 'string',
                description: 'Recipient phone number (international or national format)',
                minLength: 5
            )
        ]
        string $number,
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
    ) {
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
            Schema(type: 'string', description: 'WhatsApp device identifier (international phone number)', minLength: 6)
        ]
        string $device,
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
    ) {
        return $this->run([
            'action' => 'send_group',
            'device' => $device,
            'name' => $name,
            'message' => $message,
            'attachments' => $attachments
        ]);
    }

    private function run($args)
    {
        if (!is_array($args) || !isset($args['device']) || $args['device'] == '') {
            return;
        }
        $args['device'] = $this->formatNumber($args['device']);
        $this->cleanup($args, true);
        $this->runInBackground($args);
        $return = $this->fetchReturn($args);
        $this->cleanup($args, false);
        return $return;
    }

    private function cleanup($args, $start = true)
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

    private function runInBackground($args)
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
                    ' ' .
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

    private function fetchReturn($args)
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

    private function getFolder()
    {
        $currentDir = __DIR__;
        if (strpos($currentDir, 'vendor') !== false) {
            $projectRoot = realpath($currentDir . '/../../../');
        } else {
            $projectRoot = $currentDir;
        }
        return $projectRoot . '/whatsapp_data';
    }

    private function getNodePath()
    {
        if (defined('NODE_PATH')) {
            return NODE_PATH;
        } else {
            return 'node';
        }
    }

    private function formatNumber($number)
    {
        // replace leading zero with 49
        $number = preg_replace('/^0+/', '49', $number);
        // remove non-digit characters
        $number = preg_replace('/\D/', '', $number);
        return $number;
    }
}
