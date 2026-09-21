<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    responder(['sucesso' => false, 'erro' => 'Use POST'], 405);
}

exigirToken();
$dados = corpoJson();
$dispositivoId = dispositivoObrigatorio($dados);
$comando = $dados['comando'] ?? '';

if (!in_array($comando, ['ligar_bomba', 'desligar_bomba'], true)) {
    responder(['sucesso' => false, 'erro' => 'Comando inválido'], 422);
}

// Evita acumular vários comandos conflitantes.
$limpar = banco()->prepare(
    "UPDATE comandos_bomba
     SET status = 'expirado'
     WHERE dispositivo_id = :dispositivo_id AND status = 'pendente'"
);
$limpar->execute([':dispositivo_id' => $dispositivoId]);

$stmt = banco()->prepare(
    "INSERT INTO comandos_bomba (dispositivo_id, comando)
     VALUES (:dispositivo_id, :comando)"
);
$stmt->execute([
    ':dispositivo_id' => $dispositivoId,
    ':comando' => $comando,
]);

responder([
    'sucesso' => true,
    'mensagem' => 'Comando criado',
    'comando_id' => (int) banco()->lastInsertId(),
]);