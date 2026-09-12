<?php
declare(strict_types=1);

namespace vielhuber\wahelper\tests;

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\TestWith;
use vielhuber\wahelper\wahelper;

final class Test extends TestCase
{
    public function testMissingDeviceReturnsError(): void
    {
        $result = (new wahelper())->fetchMessages('');

        $this->assertFalse($result->success);
        $this->assertSame('error', $result->message);
        $this->assertNull($result->data);
    }

    #[TestWith(['', 1])]
    #[TestWith(['', 2])]
    #[TestWith(['{"message":', 2])]
    #[TestWith(['null', 2])]
    #[TestWith(['[]', 2])]
    #[TestWith(['false', 2])]
    #[TestWith(['42', 2])]
    #[TestWith(['"unexpected"', 2])]
    #[TestWith(['{}', 2])]
    #[TestWith(['{"success":false,"message":"loading_state"}', 2])]
    public function testIncompleteResponseTimesOut(string $response, int $timeout): void
    {
        $result = $this->fetchResponse($response, $timeout);

        $this->assertFalse($result->success);
        $this->assertSame('timeout_error', $result->message);
    }

    #[TestWith(['{"success":true,"message":"success","data":[{"id":"example"}]}'])]
    #[TestWith(['{"success":false,"message":"error","data":null}'])]
    public function testCompleteResponseIsReturnedUnchanged(string $response): void
    {
        $this->assertEquals(json_decode($response), $this->fetchResponse($response, 1));
    }

    public function testResponseArrivingDuringTheLastWaitIsReturned(): void
    {
        $response = '{"success":true,"message":"messages_fetched","data":[]}';

        $this->assertEquals(json_decode($response), $this->fetchResponse('', 1, $response));
    }

    #[TestWith(['fetchMessages', ['device', 'filter', 'limit', 'order', 'exclude_body'], 'fetch_messages'])]
    #[TestWith(['viewMessage', ['device', 'id'], 'view_message'])]
    #[TestWith(['sendUser', ['device', 'number', 'message', 'attachments'], 'send_user_message'])]
    #[TestWith(['sendGroup', ['device', 'name', 'message', 'attachments'], 'send_group_message'])]
    public function testPublicParameterAndToolNamesRemainCompatible(
        string $method,
        array $parameters,
        string $tool
    ): void {
        $reflection = new \ReflectionMethod(wahelper::class, $method);

        $this->assertSame(
            $parameters,
            array_map(fn($parameter) => $parameter->getName(), $reflection->getParameters())
        );
        $this->assertSame('object', (string) $reflection->getReturnType());
        $this->assertSame(
            $tool,
            $reflection->getAttributes(\PhpMcp\Server\Attributes\McpTool::class)[0]->getArguments()['name']
        );
    }

    private function fetchResponse(string $response, int $timeout, ?string $delayedResponse = null): object
    {
        $helper = new wahelper();
        (new \ReflectionProperty(wahelper::class, 'timeout'))->setValue($helper, $timeout);
        $folder = (new \ReflectionMethod(wahelper::class, 'getFolder'))->invoke($helper);
        $createdFolder = !is_dir($folder);
        if ($createdFolder) {
            mkdir($folder, 0755, true);
        }
        $device = 'regression-' . bin2hex(random_bytes(16));
        $requestId = bin2hex(random_bytes(16));
        $path = $folder . '/whatsapp_' . $device . '_' . $requestId . '.json';
        $writer = null;
        try {
            file_put_contents($path, $response);
            if ($delayedResponse !== null) {
                $writer = proc_open(
                    [
                        PHP_BINARY,
                        '-r',
                        'usleep(200000); file_put_contents($argv[1], $argv[2]);',
                        $path,
                        $delayedResponse
                    ],
                    [],
                    $pipes
                );
                $this->assertIsResource($writer);
            }
            return (new \ReflectionMethod(wahelper::class, 'fetchReturn'))->invoke($helper, [
                'device' => $device,
                'request_id' => $requestId
            ]);
        } finally {
            $writerStatus = is_resource($writer) ? proc_close($writer) : 0;
            unlink($path);
            if ($createdFolder) {
                rmdir($folder);
            }
            if ($delayedResponse !== null) {
                $this->assertSame(0, $writerStatus);
            }
        }
    }
}
