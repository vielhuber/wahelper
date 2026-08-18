<?php
declare(strict_types=1);

namespace vielhuber\wahelper\tests;

use PHPUnit\Framework\TestCase;
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
}
