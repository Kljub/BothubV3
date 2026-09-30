<?php

declare(strict_types=1);

namespace BotHub\BotCore;

/**
 * Secrets shared with the bot (bot/src/core/secrets.ts, same format):
 * AES-256-GCM, blob = nonce (12 bytes) || ciphertext || tag (16 bytes).
 *
 * Key: ENV BOTHUB_SECRET_KEY (base64, 32 bytes) or DATA_DIR/secret.key.
 * The API creates the file on first start (bin/share-data.php); the bot
 * only reads it. Clear-text secrets are never logged or returned.
 */
final class SecretBox
{
    private const NONCE = 12;
    private const TAG = 16;

    public function __construct(private readonly string $key)
    {
        if (strlen($key) !== 32) {
            throw new \InvalidArgumentException('secret key must be 32 bytes');
        }
    }

    /** Loads the key from ENV or the key file; creates the file if neither exists. */
    public static function loadOrCreate(?string $dataDir = null): self
    {
        $fromEnv = getenv('BOTHUB_SECRET_KEY');
        if (is_string($fromEnv) && $fromEnv !== '') {
            return new self(self::decodeKey($fromEnv));
        }
        $file = rtrim($dataDir ?? (getenv('DATA_DIR') ?: '/data'), '/') . '/secret.key';
        if (!is_file($file)) {
            self::createKeyFile($file);
        }
        $raw = (string) file_get_contents($file);
        // Same rule as the bot: 32 raw bytes or their base64 text.
        return new self(strlen($raw) === 32 ? $raw : self::decodeKey(trim($raw)));
    }

    public function encrypt(string $plain): string
    {
        $nonce = random_bytes(self::NONCE);
        $tag = '';
        $body = openssl_encrypt($plain, 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA, $nonce, $tag, '', self::TAG);
        if ($body === false) {
            throw new \RuntimeException('encryption failed');
        }
        return $nonce . $body . $tag;
    }

    public function decrypt(string $blob): string
    {
        if (strlen($blob) <= self::NONCE + self::TAG) {
            throw new \RuntimeException('encrypted value too short');
        }
        $plain = openssl_decrypt(
            substr($blob, self::NONCE, -self::TAG),
            'aes-256-gcm',
            $this->key,
            OPENSSL_RAW_DATA,
            substr($blob, 0, self::NONCE),
            substr($blob, -self::TAG),
        );
        if ($plain === false) {
            throw new \RuntimeException('decryption failed (wrong key or damaged value)');
        }
        return $plain;
    }

    /**
     * bots.token_fingerprint: HMAC-SHA-256 with a salt derived from the
     * secret key, so duplicate tokens are found without decrypting them.
     */
    public function fingerprint(string $plain): string
    {
        $salt = hash_hkdf('sha256', $this->key, 32, 'bothub token fingerprint');
        return hash_hmac('sha256', $plain, $salt, true);
    }

    private static function decodeKey(string $base64): string
    {
        $key = base64_decode($base64, true);
        if ($key === false || strlen($key) !== 32) {
            throw new \InvalidArgumentException('secret key must be 32 bytes, base64 encoded');
        }
        return $key;
    }

    private static function createKeyFile(string $file): void
    {
        $dir = dirname($file);
        if (!is_dir($dir) && !mkdir($dir, 0o750, true) && !is_dir($dir)) {
            throw new \RuntimeException("Cannot create data directory {$dir}");
        }
        // 'x' fails if another process created the file first; then we read theirs.
        $fh = @fopen($file, 'x');
        if ($fh === false) {
            return;
        }
        fwrite($fh, base64_encode(random_bytes(32)) . "\n");
        fclose($fh);
        self::shareWithBot($file);
    }

    /**
     * The bot runs as another user (node, uid/gid 1000) and must read the
     * key: owner rw, group r, others nothing. Group from BOTHUB_SHARED_GID.
     */
    public static function shareWithBot(string $file): void
    {
        $gid = (int) (getenv('BOTHUB_SHARED_GID') ?: 1000);
        if (function_exists('posix_geteuid') && posix_geteuid() === 0) {
            @chgrp($file, $gid);
        }
        @chmod($file, 0o640);
    }
}
