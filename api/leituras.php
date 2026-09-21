<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    responder([
        'sucesso' => false,
        'erro' => 'Use o método POST'
    ], 405);
}

exigirToken();

$dados = corpoJson();

$dispositivoId = dispositivoObrigatorio($dados);
$umidadeSolo = decimalObrigatorio($dados, 'umidade_solo');
$nivelAgua = decimalObrigatorio($dados, 'nivel_agua');

if (!array_key_exists('rele_bomba', $dados)) {
    responder([
        'sucesso' => false,
        'erro' => 'Campo obrigatório: rele_bomba'
    ], 422);
}

$releBomba = filter_var(
    $dados['rele_bomba'],
    FILTER_VALIDATE_BOOLEAN,
    FILTER_NULL_ON_FAILURE
);

if ($releBomba === null) {
    responder([
        'sucesso' => false,
        'erro' => 'rele_bomba deve ser true ou false'
    ], 422);
}

$dataHora = null;

if (!empty($dados['data_hora'])) {
    $data = DateTime::createFromFormat(
        DateTime::ATOM,
        (string) $dados['data_hora']
    );

    if ($data !== false) {
        $dataHora = $data->format('Y-m-d H:i:s');
    }
}

$pdo = banco();

$sql = "
    INSERT INTO automation_readings
    (
        device_id,
        plant_id,
        soil_moisture,
        water_pump_relay,
        water_level,
        device_date_time
    )
    SELECT
        id,
        plant_id,
        :soil_moisture,
        :water_pump_relay,
        :water_level,
        :device_date_time
    FROM devices
    WHERE device_code = :device_code
      AND active = 1
    LIMIT 1
";

$stmt = $pdo->prepare($sql);

$stmt->execute([
    ':soil_moisture' => $umidadeSolo,
    ':water_pump_relay' => $releBomba ? 1 : 0,
    ':water_level' => $nivelAgua,
    ':device_date_time' => $dataHora,
    ':device_code' => $dispositivoId
]);

if ($stmt->rowCount() === 0) {
    responder([
        'sucesso' => false,
        'erro' => 'Dispositivo não cadastrado ou inativo'
    ], 404);
}

$atualizar = $pdo->prepare(
    'UPDATE devices
     SET last_seen_at = NOW()
     WHERE device_code = :device_code'
);

$atualizar->execute([
    ':device_code' => $dispositivoId
]);

responder([
    'sucesso' => true,
    'mensagem' => 'Leitura registrada'
]);