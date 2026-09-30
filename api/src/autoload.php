<?php

declare(strict_types=1);

// PSR-4 autoloader for BotHub\ => src/ until the API gets composer (Slim 4).

spl_autoload_register(static function (string $class): void {
    if (!str_starts_with($class, 'BotHub\\')) {
        return;
    }
    $file = __DIR__ . '/' . str_replace('\\', '/', substr($class, 7)) . '.php';
    if (is_file($file)) {
        require $file;
    }
});
