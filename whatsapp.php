<?php
final class WhatsApp
{
    static function call($args)
    {
        self::resetResponse();
        self::runInBackground($args);
        return self::fetchReturn();
    }

    private static function resetResponse()
    {
        if (file_exists(self::getFolder() . '/server.json')) {
            unlink(self::getFolder() . '/server.json');
        }
    }

    private static function runInBackground($args)
    {
        $cli_args = trim(
            implode(
                ' ',
                array_map(
                    function ($args__key, $args__value) {
                        return '--' . str_replace('_', '-', $args__key) . ' "' . $args__value . '"';
                    },
                    array_keys($args),
                    $args
                )
            )
        );

        if (strtoupper(substr(PHP_OS, 0, 3)) === 'WIN') {
            file_put_contents(
                self::getFolder() . '/fetch.bat',
                '@echo off' .
                    PHP_EOL .
                    'cd /d ' .
                    self::getFolder() .
                    '' .
                    PHP_EOL .
                    'start /B "" ' .
                    NODE_PATH .
                    ' server.js ' .
                    $cli_args .
                    ' > NUL 2>&1'
            );
            pclose(popen('start /B cmd /c ' . self::getFolder() . '/server.bat', 'r'));
        } else {
            shell_exec(
                'cd ' .
                    self::getFolder() .
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
            if (file_exists(self::getFolder() . '/server.json')) {
                $return = json_decode(file_get_contents(self::getFolder() . '/server.json'));
            }
            sleep(0.5);
        }
        return $return;
    }

    private static function getFolder()
    {
        return realpath(dirname(__FILE__));
    }
}
