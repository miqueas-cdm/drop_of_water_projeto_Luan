<?php
declare(strict_types=1);

const DB_HOST = 'localhost';
const DB_NAME = 'u759455467_projt';
const DB_USER = 'u759455467_projt';
const DB_PASS = 'Projt@123';

// Use o mesmo token no ESP32 e nas requisições administrativas.
const API_TOKEN = 'xXVEua9xSmVi2C7TYb64Bs2DotJJFdyp';

// Tempo máximo que um comando pode permanecer pendente.
const COMANDO_EXPIRA_MINUTOS = 10;

function responder(array $dados, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($dados, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function obterToken(): string
{
    $autorizacao = $_SERVER['HTTP_AUTHORIZATION'] ?? '';

    if (preg_match('/^Bearer\\s+(.+)$/i', $autorizacao, $matches)) {
        return trim($matches[1]);
    }

    // Compatibilidade com servidores que não repassam Authorization.
    return trim($_SERVER['HTTP_X_API_TOKEN'] ?? '');
}

function exigirToken(): void
{
    $recebido = obterToken();

    if ($recebido === '' || !hash_equals(API_TOKEN, $recebido)) {
        responder(['sucesso' => false, 'erro' => 'Não autorizado'], 401);
    }
}

function banco(): PDO
{
    static $pdo = null;

    if ($pdo instanceof PDO) {
        return $pdo;
    }

    try {
        $pdo = new PDO(
            'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
            DB_USER,
            DB_PASS,
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]
        );
    } catch (Throwable $e) {
        responder(['sucesso' => false, 'erro' => 'Erro de conexão com o banco'], 500);
    }

    return $pdo;
}

function corpoJson(): array
{
    $corpo = file_get_contents('php://input');
    $dados = json_decode($corpo ?: '', true);

    if (!is_array($dados)) {
        responder(['sucesso' => false, 'erro' => 'JSON inválido'], 400);
    }

    return $dados;
}

function decimalObrigatorio(array $dados, string $campo): float
{
    if (!isset($dados[$campo]) || !is_numeric($dados[$campo])) {
        responder(['sucesso' => false, 'erro' => "Campo obrigatório: {$campo}"], 422);
    }

    $valor = (float) $dados[$campo];

    if ($valor < 0 || $valor > 100) {
        responder(['sucesso' => false, 'erro' => "{$campo} deve estar entre 0 e 100"], 422);
    }

    return $valor;
}

function dispositivoObrigatorio(array $dados): string
{
    $id = trim((string) ($dados['dispositivo_id'] ?? ''));

    if ($id === '' || strlen($id) > 80 || !preg_match('/^[a-zA-Z0-9_.-]+$/', $id)) {
        responder(['sucesso' => false, 'erro' => 'dispositivo_id inválido'], 422);
    }

    return $id;
}