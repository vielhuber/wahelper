<?php
final class WhatsApp
{
    static $timeout = 120;

    static function run($args)
    {
        if (!is_array($args) || !isset($args['device']) || $args['device'] == '') {
            return;
        }
        self::cleanup($args);
        self::runInBackground($args);
        $return = self::fetchReturn($args);
        self::cleanup($args);
        return $return;
    }

    private static function cleanup($args)
    {
        if (file_exists(self::getFolder() . '/whatsapp_' . $args['device'] . '.json')) {
            unlink(self::getFolder() . '/whatsapp_' . $args['device'] . '.json');
        }
        if (file_exists(self::getFolder() . '/whatsapp_' . $args['device'] . '.bat')) {
            unlink(self::getFolder() . '/whatsapp_' . $args['device'] . '.bat');
        }
    }

    private static function runInBackground($args)
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
                self::getFolder() . '/whatsapp_' . $args['device'] . '.bat',
                '@echo off' .
                    PHP_EOL .
                    'cd /d ' .
                    self::getFolder() .
                    '' .
                    PHP_EOL .
                    'start /B "" ' .
                    self::getNodePath() .
                    ' whatsapp.js ' .
                    $cli_args .
                    ' >> whatsapp.startup.log 2>&1'
            );
            pclose(popen('start /B cmd /c ' . self::getFolder() . '/whatsapp_' . $args['device'] . '.bat', 'r'));
        } else {
            shell_exec(
                'cd ' .
                    self::getFolder() .
                    ' && ' .
                    self::getNodePath() .
                    ' --no-deprecation --disable-warning=ExperimentalWarning whatsapp.js ' .
                    $cli_args .
                    ' >> whatsapp.startup.log 2>&1 &'
            );
        }
    }

    private static function fetchReturn($args)
    {
        $return = (object) [];
        $timeout = self::$timeout;
        while (!property_exists($return, 'message') || $return->message === 'loading_state') {
            if (file_exists(self::getFolder() . '/whatsapp_' . $args['device'] . '.json')) {
                $return = json_decode(file_get_contents(self::getFolder() . '/whatsapp_' . $args['device'] . '.json'));
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

    private static function getFolder()
    {
        return getcwd() . '/wahelper_data';
    }

    private static function getNodePath()
    {
        if (defined('NODE_PATH')) {
            return NODE_PATH;
        } else {
            return 'node';
        }
    }
}
