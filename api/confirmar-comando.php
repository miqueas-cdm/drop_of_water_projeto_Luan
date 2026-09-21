<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    responder(['sucesso' => false, 'erro' => 'Use POST'], 405);
}

exigirToken();
$dados = corpoJson();
$dispositivoId = dispositivoObrigatorio($dados);
$comandoId = filter_var($dados['comando_id'] ?? null, FILTER_VALIDATE_INT);

if (!$comandoId || $comandoId < 1) {
    responder(['sucesso' => false, 'erro' => 'comando_id inválido'], 422);
}

$releBomba = filter_var($dados['rele_bomba'] ?? null, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
if ($releBomba === null) {
    responder(['sucesso' => false, 'erro' => 'rele_bomba deve ser true ou false'], 422);
}

$stmt = banco()->prepare(
    "UPDATE comandos_bomba
     SET status = 'executado', executado_em = NOW()
     WHERE id = :id AND dispositivo_id = :dispositivo_id AND status = 'pendente'"
);
$stmt->execute([
    ':id' => $comandoId,
    ':dispositivo_id' => $dispositivoId,
]);

if ($stmt->rowCount() === 0) {
    responder(['sucesso' => false, 'erro' => 'Comando não encontrado ou já processado'], 404);
}

responder(['sucesso' => true, 'mensagem' => 'Comando confirmado']);