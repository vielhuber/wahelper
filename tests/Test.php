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
        $this->assertEquals(json_decode($response), $this->fetchResponse($response, 2));
    }

    private function fetchResponse(string $response, int $timeout): object
    {
        $helper = new wahelper();
        (new \ReflectionProperty(wahelper::class, 'timeout'))->setValue($helper, $timeout);
        $folder = (new \ReflectionMethod(wahelper::class, 'getFolder'))->invoke($helper);
        $createdFolder = !is_dir($folder);
        if ($createdFolder) {
            mkdir($folder, 0755, true);
        }
        $device = 'regression-' . bin2hex(random_bytes(16));
        $path = $folder . '/whatsapp_' . $device . '.json';
        try {
            file_put_contents($path, $response);
            return (new \ReflectionMethod(wahelper::class, 'fetchReturn'))->invoke($helper, ['device' => $device]);
        } finally {
            unlink($path);
            if ($createdFolder) {
                rmdir($folder);
            }
        }
    }
}
