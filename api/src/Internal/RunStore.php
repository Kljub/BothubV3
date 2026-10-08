<?php

declare(strict_types=1);

namespace BotHub\Internal;

use PDO;

/**
 * Playbacks and errors (run_traces, written by the bot): the runs of a
 * command for the builder's Playbacks, the failed runs of a bot for the
 * Errors page, dismiss and mute.
 *
 * "Fixed": a later successful run of the same command passed the block
 * that had failed.
 */
final class RunStore
{
    private const SUMMARY = "t.id, t.command_id, c.name AS command_name, c.kind AS command_kind, t.at, t.source,
        t.user_id, t.user_name, t.guild_id, t.guild_name, t.channel_id, t.channel_name, t.ok,
        t.error_node, t.error_key, t.error_hint, t.error_text, t.dismissed,
        EXISTS (SELECT 1 FROM run_error_mutes m WHERE m.command_id = t.command_id AND m.node_id = t.error_node AND m.error_key = t.error_key) AS muted,
        (t.ok = 0 AND EXISTS (SELECT 1 FROM run_traces r2, json_each(r2.steps) j
            WHERE r2.command_id = t.command_id AND r2.id > t.id AND r2.ok = 1
              AND json_extract(j.value, '$.node') = t.error_node AND json_extract(j.value, '$.status') = 'ok')) AS fixed";

    public function __construct(private readonly PDO $pdo)
    {
    }

    /**
     * Runs of one command (newest first), or with $errors the failed runs of
     * the bot from the last 7 days that are not dismissed.
     *
     * @return list<array<string, mixed>>
     */
    public function list(int $botId, mixed $commandId, bool $errors, bool $withMuted, mixed $limit): array
    {
        $where = 't.bot_id = ?';
        $args = [$botId];
        if ($commandId !== null && $commandId !== '') {
            $where .= ' AND t.command_id = ?';
            $args[] = (int) $commandId;
        }
        if ($errors) {
            $where .= " AND t.ok = 0 AND t.dismissed = 0 AND t.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')";
        }
        $n = is_numeric($limit) ? max(1, min(200, (int) $limit)) : 50;
        $st = $this->pdo->prepare('SELECT ' . self::SUMMARY . " FROM run_traces t JOIN commands c ON c.id = t.command_id WHERE $where ORDER BY t.id DESC LIMIT $n");
        $st->execute($args);
        $rows = array_map(fn (array $r): array => $this->summary($r), $st->fetchAll(PDO::FETCH_ASSOC));
        return array_values($errors && !$withMuted ? array_filter($rows, static fn (array $r): bool => !$r['muted']) : $rows);
    }

    /** One run with its steps, start variables and warnings. */
    public function get(int $botId, int $id): array
    {
        $st = $this->pdo->prepare('SELECT ' . self::SUMMARY . ', t.run_key, t.start_vars, t.steps, t.warnings FROM run_traces t JOIN commands c ON c.id = t.command_id WHERE t.bot_id = ? AND t.id = ?');
        $st->execute([$botId, $id]);
        $r = $st->fetch(PDO::FETCH_ASSOC) ?: throw ApiError::notFound('error.not_found');
        $out = $this->summary($r);
        $out['start_vars'] = (object) (json_decode((string) $r['start_vars'], true) ?: []);
        $out['steps'] = json_decode((string) $r['steps'], true) ?: [];
        $out['warnings'] = json_decode((string) $r['warnings'], true) ?: [];
        return $out;
    }

    public function dismiss(int $botId, int $id): void
    {
        $st = $this->pdo->prepare('UPDATE run_traces SET dismissed = 1 WHERE bot_id = ? AND id = ?');
        $st->execute([$botId, $id]);
        if ($st->rowCount() === 0) {
            throw ApiError::notFound('error.not_found');
        }
    }

    /** Dismisses every failed run of the bot (or of one command). */
    public function dismissAll(int $botId, mixed $commandId): int
    {
        $sql = 'UPDATE run_traces SET dismissed = 1 WHERE bot_id = ? AND ok = 0 AND dismissed = 0';
        $args = [$botId];
        if ($commandId !== null && $commandId !== '') {
            $sql .= ' AND command_id = ?';
            $args[] = (int) $commandId;
        }
        $st = $this->pdo->prepare($sql);
        $st->execute($args);
        return $st->rowCount();
    }

    /** Mutes (or unmutes) the error of a run: same block, same reason. */
    public function mute(int $botId, int $id, bool $muted): void
    {
        $st = $this->pdo->prepare('SELECT command_id, error_node, error_key FROM run_traces WHERE bot_id = ? AND id = ? AND ok = 0');
        $st->execute([$botId, $id]);
        $r = $st->fetch(PDO::FETCH_ASSOC) ?: throw ApiError::notFound('error.not_found');
        if ($r['error_node'] === null || $r['error_key'] === null) {
            throw new ApiError(422, 'error.validation', ['field' => 'error']);
        }
        $args = [(int) $r['command_id'], (string) $r['error_node'], mb_substr((string) $r['error_key'], 0, 100)];
        $sql = $muted
            ? 'INSERT OR IGNORE INTO run_error_mutes (command_id, node_id, error_key) VALUES (?, ?, ?)'
            : 'DELETE FROM run_error_mutes WHERE command_id = ? AND node_id = ? AND error_key = ?';
        $this->pdo->prepare($sql)->execute($args);
    }

    /** @param array<string, mixed> $r */
    private function summary(array $r): array
    {
        return [
            'id' => (int) $r['id'],
            'command_id' => (int) $r['command_id'],
            'command_name' => $r['command_name'],
            'command_kind' => $r['command_kind'],
            'time' => $r['at'],
            'source' => $r['source'],
            'user_id' => $r['user_id'],
            'user_name' => $r['user_name'],
            'guild_id' => $r['guild_id'],
            'guild_name' => $r['guild_name'],
            'channel_id' => $r['channel_id'],
            'channel_name' => $r['channel_name'],
            'ok' => (bool) $r['ok'],
            'error_node' => $r['error_node'],
            'error_key' => $r['error_key'],
            'error_hint' => $r['error_hint'] !== null ? json_decode((string) $r['error_hint'], true) : null,
            'error_text' => $r['error_text'],
            'dismissed' => (bool) $r['dismissed'],
            'muted' => (bool) $r['muted'],
            'fixed' => (bool) $r['fixed'],
        ];
    }
}
