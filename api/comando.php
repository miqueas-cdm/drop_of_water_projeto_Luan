<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    responder(['sucesso' => false, 'erro' => 'Use GET'], 405);
}

exigirToken();
$dispositivoId = dispositivoObrigatorio($_GET);

// Expira comandos muito antigos.
$expirar = banco()->prepare(
    "UPDATE comandos_bomba
     SET status = 'expirado'
     WHERE dispositivo_id = :dispositivo_id
       AND status = 'pendente'
       AND criado_em < (NOW() - INTERVAL " . (int) COMANDO_EXPIRA_MINUTOS . " MINUTE)"
);
$expirar->execute([':dispositivo_id' => $dispositivoId]);

$stmt = banco()->prepare(
    "SELECT id, comando, criado_em
     FROM comandos_bomba
     WHERE dispositivo_id = :dispositivo_id AND status = 'pendente'
     ORDER BY id ASC
     LIMIT 1"
);
$stmt->execute([':dispositivo_id' => $dispositivoId]);
$comando = $stmt->fetch();

if (!$comando) {
    responder(['sucesso' => true, 'comando' => null]);
}

responder([
    'sucesso' => true,
    'comando' => $comando['comando'],
    'comando_id' => (int) $comando['id'],
    'criado_em' => $comando['criado_em'],
]);