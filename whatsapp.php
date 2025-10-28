<?php
final class WhatsApp
{
    static $folder = realpath(dirname(__FILE__));

    static function call($args)
    {
        self::resetResponse();
        self::runInBackground($args);
        return self::fetchReturn();
    }

    private static function resetResponse()
    {
        if (file_exists(self::$folder . '/server.json')) {
            unlink(self::$folder . '/server.json');
        }
    }

    private static function runInBackground($args)
    {
        $cli_args = trim(
            implode(
                ' ',
                array_map(
                    function ($args__key, $args__value) {
                        return '--' . $args__key . ' "' . $args__value . '"';
                    },
                    array_keys($args),
                    $args
                )
            )
        );

        if (strtoupper(substr(PHP_OS, 0, 3)) === 'WIN') {
            file_put_contents(
                self::$folder . '/fetch.bat',
                '@echo off' .
                    PHP_EOL .
                    'cd /d ' .
                    self::$folder .
                    '' .
                    PHP_EOL .
                    'start /B "" ' .
                    NODE_PATH .
                    ' server.js ' .
                    $cli_args .
                    ' > NUL 2>&1'
            );
            pclose(popen('start /B cmd /c ' . self::$folder . '/server.bat', 'r'));
        } else {
            shell_exec(
                'cd ' .
                    self::$folder .
                    ' && ' .
                    NODE_PATH .
                    ' --no-deprecation server.js ' .
                    $cli_args .
                    ' > /dev/null 2>&1 &'
            );
        }
    }

    private static function fetchReturn()
    {
        $return = (object) [];
        while ($return === null || $return->message === 'loading_state') {
            if (file_exists(self::$folder . '/server.json')) {
                $return = json_decode(file_get_contents(self::$folder . '/server.json'));
            }
            sleep(0.5);
        }
        return $return;
    }
}
