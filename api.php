<?php
declare(strict_types=1);

const ROOM_TTL = 7200;
const MEMBER_TTL = 300;
const MAX_ROOM_MEMBERS = 6;
const MAX_SIGNAL_EVENTS = 1200;
const MAX_SDP_LENGTH = 20000;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function respond(int $status, array $data): never
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function requestBody(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 24000) {
        respond(413, ['error' => 'Request body is too large.']);
    }
    $body = json_decode($raw, true);
    if (!is_array($body)) {
        respond(400, ['error' => 'Request body must be a JSON object.']);
    }
    return $body;
}

function roomCode(mixed $value): string
{
    if (!is_string($value) || !preg_match('/^[A-HJ-NP-Z2-9]{8}$/', $value)) {
        respond(400, ['error' => 'Invalid room code.']);
    }
    return $value;
}

function bearerToken(): string
{
    $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!is_string($authorization) || !preg_match('/^Bearer ([A-Fa-f0-9]{64})$/', $authorization, $matches)) {
        respond(401, ['error' => 'A valid room token is required.']);
    }
    return hash('sha256', $matches[1]);
}

function roomPath(string $code): string
{
    return __DIR__ . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'rooms' . DIRECTORY_SEPARATOR . $code . '.json';
}

function saveRoom($file, array $room): void
{
    $json = json_encode($room, JSON_UNESCAPED_SLASHES);
    if ($json === false || ftruncate($file, 0) === false || rewind($file) === false || fwrite($file, $json) === false || fflush($file) === false) {
        error_log('ConMan could not persist room data.');
        respond(500, ['error' => 'The room could not be saved.']);
    }
}

function pruneAcknowledgedEvents(array &$room): void
{
    $minimumCursor = min(array_column($room['members'], 'cursor'));
    $room['events'] = array_values(array_filter(
        $room['events'],
        static fn(array $event): bool => $event['id'] > $minimumCursor
    ));
}

function withRoom(string $code, string $tokenHash, callable $callback, bool $allowJoin = false): never
{
    $path = roomPath($code);
    $file = @fopen($path, 'r+');
    if ($file === false) {
        respond(404, ['error' => 'Room not found or expired.']);
    }
    if (!flock($file, LOCK_EX)) {
        fclose($file);
        error_log('ConMan could not lock room data.');
        respond(503, ['error' => 'The room is temporarily unavailable.']);
    }

    $contents = stream_get_contents($file);
    $room = $contents === false ? null : json_decode($contents, true);
    if (!is_array($room) || !isset($room['created'], $room['updated'], $room['events'], $room['nextId'], $room['members'], $room['nextMemberOrder'])) {
        flock($file, LOCK_UN);
        fclose($file);
        respond(410, ['error' => 'This room was created by an older version. Create a new room to continue.']);
    }
    if (time() - (int)$room['updated'] > ROOM_TTL) {
        flock($file, LOCK_UN);
        fclose($file);
        @unlink($path);
        respond(404, ['error' => 'Room not found or expired.']);
    }
    $memberId = null;
    if (!$allowJoin) {
        foreach ($room['members'] as $candidateId => $member) {
            if (is_string($member['token'] ?? null) && hash_equals($member['token'], $tokenHash)) {
                $memberId = (string)$candidateId;
                break;
            }
        }
    }
    if (!$allowJoin && $memberId === null) {
        flock($file, LOCK_UN);
        fclose($file);
        respond(403, ['error' => 'This token is not authorized for the room.']);
    }

    $now = time();
    $ownerGone = false;
    foreach ($room['members'] as $candidateId => $member) {
        if ($candidateId === $memberId || $now - (int)$member['lastSeen'] <= MEMBER_TTL) {
            continue;
        }
        if ((int)$member['order'] === 1) {
            $ownerGone = true;
        }
        unset($room['members'][$candidateId]);
    }
    if ($ownerGone) {
        flock($file, LOCK_UN);
        fclose($file);
        @unlink($path);
        respond(410, ['error' => 'The room creator is no longer connected. Create a new room to continue.']);
    }
    $activeMembers = array_fill_keys(array_keys($room['members']), true);
    $room['events'] = array_values(array_filter(
        $room['events'],
        static fn(array $event): bool => isset($activeMembers[$event['from']], $activeMembers[$event['to']])
    ));
    if ($memberId !== null) {
        $room['members'][$memberId]['lastSeen'] = $now;
    }

    $result = $callback($room, $memberId, $file, $path);
    if (!is_array($result) || !isset($result['status'], $result['body'])) {
        flock($file, LOCK_UN);
        fclose($file);
        error_log('ConMan room handler returned an invalid response.');
        respond(500, ['error' => 'The room request failed.']);
    }
    if (($result['save'] ?? true) === true) {
        $room['updated'] = time();
        saveRoom($file, $room);
    }
    if (($result['delete'] ?? false) === true) {
        @unlink($path);
    }
    flock($file, LOCK_UN);
    fclose($file);
    respond((int)$result['status'], $result['body']);
}

function cleanExpiredRooms(): void
{
    $directory = __DIR__ . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'rooms';
    if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
        error_log('ConMan could not create room storage.');
        respond(500, ['error' => 'Room storage is unavailable.']);
    }
    foreach (glob($directory . DIRECTORY_SEPARATOR . '*.json') ?: [] as $path) {
        $mtime = @filemtime($path);
        if ($mtime !== false && time() - $mtime > ROOM_TTL) {
            @unlink($path);
        }
    }
}

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? '';

if ($action === 'create' && $method === 'POST') {
    requestBody();
    cleanExpiredRooms();
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for ($attempt = 0; $attempt < 5; $attempt++) {
        $code = '';
        for ($i = 0; $i < 8; $i++) {
            $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
        $path = roomPath($code);
        $file = @fopen($path, 'x');
        if ($file === false) {
            continue;
        }
        if (!flock($file, LOCK_EX)) {
            fclose($file);
            @unlink($path);
            error_log('ConMan could not lock new room data.');
            respond(503, ['error' => 'Could not create a room. Please try again.']);
        }
        $token = bin2hex(random_bytes(32));
        $memberId = bin2hex(random_bytes(8));
        $room = [
            'created' => time(),
            'updated' => time(),
            'nextId' => 1,
            'events' => [],
            'nextMemberOrder' => 2,
            'members' => [
                $memberId => [
                    'token' => hash('sha256', $token),
                    'order' => 1,
                    'lastSeen' => time(),
                    'cursor' => 0
                ]
            ]
        ];
        saveRoom($file, $room);
        flock($file, LOCK_UN);
        fclose($file);
        respond(201, ['room' => $code, 'token' => $token, 'memberId' => $memberId, 'memberOrder' => 1, 'cursor' => 0]);
    }
    respond(503, ['error' => 'Could not allocate a room. Please try again.']);
}

if ($action === 'join' && $method === 'POST') {
    $body = requestBody();
    $code = roomCode($body['room'] ?? null);
    $token = bin2hex(random_bytes(32));
    withRoom($code, hash('sha256', $token), static function (array &$room) use ($token, $code): array {
        if (count($room['members']) >= MAX_ROOM_MEMBERS) {
            return ['status' => 409, 'body' => ['error' => 'This room is full (maximum 6 devices).']];
        }
        $memberId = bin2hex(random_bytes(8));
        $order = $room['nextMemberOrder']++;
        $cursor = $room['nextId'] - 1;
        $room['members'][$memberId] = [
            'token' => hash('sha256', $token),
            'order' => $order,
            'lastSeen' => time(),
            'cursor' => $cursor
        ];
        return [
            'status' => 200,
            'body' => ['room' => $code, 'token' => $token, 'memberId' => $memberId, 'memberOrder' => $order, 'cursor' => $cursor]
        ];
    }, true);
}

if ($action === 'events' && $method === 'GET') {
    $code = roomCode($_GET['room'] ?? null);
    $tokenHash = bearerToken();
    $after = filter_var($_GET['after'] ?? '0', FILTER_VALIDATE_INT);
    if ($after === false || $after < 0) {
        respond(400, ['error' => 'Invalid event cursor.']);
    }
    withRoom($code, $tokenHash, static function (array &$room, ?string $memberId) use ($after): array {
        if ($memberId === null || $after > $room['nextId'] - 1) {
            return ['status' => 400, 'body' => ['error' => 'Invalid event cursor.']];
        }
        $room['members'][$memberId]['cursor'] = $after;
        pruneAcknowledgedEvents($room);
        $events = array_map(
            static fn(array $event): array => ['id' => $event['id'], 'from' => $event['from'], 'type' => $event['type'], 'payload' => $event['payload']],
            array_values(array_filter($room['events'], static fn(array $event): bool => $event['id'] > $after && $event['to'] === $memberId))
        );
        $members = [];
        foreach ($room['members'] as $id => $member) {
            $members[] = ['id' => $id, 'order' => $member['order']];
        }
        return [
            'status' => 200,
            'body' => ['members' => $members, 'events' => $events, 'cursor' => $room['nextId'] - 1]
        ];
    });
}

if ($action === 'signal' && $method === 'POST') {
    $code = roomCode($_GET['room'] ?? null);
    $tokenHash = bearerToken();
    $body = requestBody();
    $type = $body['type'] ?? null;
    $payload = $body['payload'] ?? null;
    if (!is_string($type) || !in_array($type, ['offer', 'answer', 'candidate', 'renegotiate'], true) || !is_array($payload)) {
        respond(400, ['error' => 'Invalid signaling message.']);
    }
    if (in_array($type, ['offer', 'answer'], true)) {
        if (!isset($payload['sdp']) || !is_string($payload['sdp']) || strlen($payload['sdp']) > MAX_SDP_LENGTH) {
            respond(400, ['error' => 'Invalid session description.']);
        }
        $payload = ['sdp' => $payload['sdp']];
    } elseif ($type === 'candidate' && (!isset($payload['candidate']) || !is_string($payload['candidate']) || strlen($payload['candidate']) > 2048)) {
        respond(400, ['error' => 'Invalid ICE candidate.']);
    } elseif ($type === 'renegotiate' && count($payload) !== 0) {
        respond(400, ['error' => 'Invalid renegotiation request.']);
    }
    $target = $body['to'] ?? null;
    if (!is_string($target) || !preg_match('/^[a-f0-9]{16}$/', $target)) {
        respond(400, ['error' => 'Invalid signaling recipient.']);
    }
    withRoom($code, $tokenHash, static function (array &$room, ?string $memberId) use ($type, $payload, $target): array {
        if ($memberId === null || $target === $memberId || !isset($room['members'][$target])) {
            return ['status' => 404, 'body' => ['error' => 'The other device is no longer in this room.']];
        }
        if (count($room['events']) >= MAX_SIGNAL_EVENTS) {
            return ['status' => 429, 'body' => ['error' => 'Signaling limit reached for this room.']];
        }
        $event = ['id' => $room['nextId']++, 'from' => $memberId, 'to' => $target, 'type' => $type, 'payload' => $payload];
        $room['events'][] = $event;
        return ['status' => 201, 'body' => ['sent' => true]];
    });
}

if ($action === 'leave' && $method === 'POST') {
    $code = roomCode($_GET['room'] ?? null);
    $tokenHash = bearerToken();
    withRoom($code, $tokenHash, static function (array &$room, ?string $memberId): array {
        if ($memberId !== null && (int)$room['members'][$memberId]['order'] === 1) {
            return ['status' => 200, 'body' => ['left' => true], 'delete' => true, 'save' => false];
        }
        if ($memberId !== null) {
            unset($room['members'][$memberId]);
            $room['events'] = array_values(array_filter(
                $room['events'],
                static fn(array $event): bool => $event['from'] !== $memberId && $event['to'] !== $memberId
            ));
        }
        return ['status' => 200, 'body' => ['left' => true]];
    });
}

respond(404, ['error' => 'Unknown API action.']);
