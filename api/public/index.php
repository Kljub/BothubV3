<?php

declare(strict_types=1);

// Phase 0 skeleton: health endpoint only. Slim 4, auth and the
// access middleware follow in phase 2 (see plan.md).

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

header('Content-Type: application/json; charset=utf-8');

if ($path === '/api/health') {
    echo json_encode(['status' => 'ok'], JSON_THROW_ON_ERROR);
    return;
}

http_response_code(404);
echo json_encode(['error' => ['key' => 'error.not_found']], JSON_THROW_ON_ERROR);
