# 🌱 Drop of Water - API de Monitoramento e Irrigação Automatizada

API REST em PHP desenvolvida para o ecossistema **Drop of Water**, projeto de automação de irrigação e monitoramento de solo e reservatório d'água voltado para dispositivos IoT (como ESP32/ESP8266) e plataformas de gestão.

---

## 📌 Sumário
- [Sobre o Projeto](#-sobre-o-projeto)
- [Arquitetura e Fluxo de Dados](#-arquitetura-e-fluxo-de-dados)
- [Tecnologias Utilizadas](#-tecnologias-utilizadas)
- [Estrutura do Repositório](#-estrutura-do-reposit%C3%B3rio)
- [Estrutura do Banco de Dados](#-estrutura-do-banco-de-dados)
- [Autenticação e Segurança](#-autentica%C3%A7%C3%A3o-e-seguran%C3%A7a)
- [Documentação dos Endpoints](#-documenta%C3%A7%C3%A3o-dos-endpoints)
  - [1. Envio de Leituras dos Sensores](#1-envio-de-leituras-dos-sensores)
  - [2. Consulta de Comandos Pendentes](#2-consulta-de-comandos-pendentes)
  - [3. Confirmação de Execução de Comando](#3-confirma%C3%A7%C3%A3o-de-execu%C3%A7%C3%A3o-de-comando)
  - [4. Criação de Novo Comando](#4-cria%C3%A7%C3%A3o-de-novo-comando)
- [Como Configurar e Executar](#-como-configurar-e-executar)
- [Exemplo de Integração (ESP32)](#-exemplo-de-integra%C3%A7%C3%A3o-esp32)
- [Licença e Autores](#-licen%C3%A7a-e-autores)

---

## 📖 Sobre o Projeto

O **Drop of Water** é um sistema de monitoramento agrícola e doméstico inteligente desenvolvido no âmbito do **Projeto Integrador III**. O objetivo principal é automatizar o processo de irrigação por meio de telemetria em tempo real (umidade do solo e nível do reservatório de água) e permitir o acionamento manual ou automatizado de bombas de irrigação através de uma fila de comandos assíncrona.

---

## 🔄 Arquitetura e Fluxo de Dados

```mermaid
flowchart TD
    subgraph IoT [" Dispositivo IoT (ESP32) "]
        S1["Sensor de Umidade do Solo"]
        S2["Sensor de Nível de Água"]
        R1["Relé da Bomba"]
    end

    subgraph Backend [" API REST PHP "]
        L["/api/leituras.php"]
        C["/api/comando.php"]
        CC["/api/confirmar-comando.php"]
        CR["/api/criar-comando.php"]
    end

    subgraph Database [" Banco de Dados MySQL "]
        DB1[("devices")]
        DB2[("automation_readings")]
        DB3[("comandos_bomba")]
    end

    subgraph App [" Dashboard / Painel de Controle "]
        UI["Interface de Usuário"]
    end

    %% Fluxo de telemetria
    S1 & S2 & R1 -->|POST JSON com telemetria| L
    L -->|Registra leitura| DB2
    L -->|Atualiza last_seen_at| DB1

    %% Fluxo de comandos do IoT
    IoT -->|GET verifica comandos| C
    C -->|Consulta status pendente| DB3
    IoT -->|POST confirma execução| CC
    CC -->|Atualiza status para executado| DB3

    %% Fluxo do Painel de Controle
    UI -->|POST agenda ligar/desligar| CR
    CR -->|Insere comando pendente| DB3
```

---

## 🛠 Tecnologias Utilizadas

- **Linguagem**: PHP 8.x (com tipagem estrita `declare(strict_types=1)`)
- **Extensões PHP**: `PDO_MYSQL`, `json`, `filter`
- **Banco de Dados**: MySQL / MariaDB (charset `utf8mb4`)
- **Protocolo de Comunicação**: HTTP/HTTPS REST com payloads em JSON
- **Hardware Compatível**: ESP32, ESP8266, Raspberry Pi Pico W, etc.

---

## 📁 Estrutura do Repositório

```text
drop_of_water_projeto_Luan/
├── api/
│   ├── comando.php            # Endpoint para o dispositivo buscar comandos pendentes
│   ├── config.php             # Configuração do banco de dados, autenticação e helpers globais
│   ├── confirmar-comando.php  # Endpoint para o dispositivo confirmar a execução do comando
│   ├── criar-comando.php      # Endpoint para a interface criar comandos de acionamento da bomba
│   └── leituras.php           # Endpoint para recebimento e gravação das leituras dos sensores
├── index.php                  # Página inicial / Healthcheck simples da API
└── README.md                  # Documentação do projeto
```

---

## 🗄 Estrutura do Banco de Dados

Para funcionamento da API, o banco de dados MySQL deve conter as seguintes tabelas estruturadas:

```sql
-- 1. Tabela de Dispositivos
CREATE TABLE IF NOT EXISTS `devices` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `plant_id` INT DEFAULT NULL,
    `device_code` VARCHAR(80) NOT NULL UNIQUE,
    `name` VARCHAR(100) DEFAULT NULL,
    `active` TINYINT(1) DEFAULT 1,
    `last_seen_at` DATETIME DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Tabela de Leituras e Telemetria
CREATE TABLE IF NOT EXISTS `automation_readings` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `device_id` INT NOT NULL,
    `plant_id` INT DEFAULT NULL,
    `soil_moisture` DECIMAL(5,2) NOT NULL,
    `water_pump_relay` TINYINT(1) NOT NULL DEFAULT 0,
    `water_level` DECIMAL(5,2) NOT NULL,
    `device_date_time` DATETIME DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT `fk_readings_device` FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Tabela de Fila de Comandos da Bomba
CREATE TABLE IF NOT EXISTS `comandos_bomba` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `dispositivo_id` VARCHAR(80) NOT NULL,
    `comando` ENUM('ligar_bomba', 'desligar_bomba') NOT NULL,
    `status` ENUM('pendente', 'executado', 'expirado') NOT NULL DEFAULT 'pendente',
    `criado_em` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `executado_em` DATETIME DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## 🔐 Autenticação e Segurança

Todas as requisições aos endpoints da API sob `/api/` exigem autenticação via Token.

Envie o token configurado no arquivo `config.php` através de um dos seguintes cabeçalhos HTTP:

1. **Authorization (Padrão Bearer)**:
   ```http
   Authorization: Bearer xXVEua9xSmVi2C7TYb64Bs2DotJJFdyp
   ```
2. **Header alternativo (para compatibilidade)**:
   ```http
   X-API-TOKEN: xXVEua9xSmVi2C7TYb64Bs2DotJJFdyp
   ```

> [!WARNING]
> Em ambientes de produção, armazene credenciais de banco e tokens através de variáveis de ambiente (`.env`) e utilize conexões seguras sob **HTTPS**.

---

## 📡 Documentação dos Endpoints

### 1. Envio de Leituras dos Sensores
Recebe os dados coletados pelos sensores do dispositivo e grava no histórico de telemetria.

- **URL**: `/api/leituras.php`
- **Método**: `POST`
- **Headers**:
  - `Content-Type: application/json`
  - `Authorization: Bearer <API_TOKEN>`

#### Corpo da Requisição (JSON)
```json
{
  "dispositivo_id": "ESP32_PLANTA_01",
  "umidade_solo": 45.5,
  "nivel_agua": 82.0,
  "rele_bomba": false,
  "data_hora": "2026-09-21T18:30:00Z"
}
```

| Campo | Tipo | Obrigatório | Descrição |
| :--- | :--- | :--- | :--- |
| `dispositivo_id` | String | Sim | Identificador cadastrado do dispositivo (`device_code`) |
| `umidade_solo` | Float | Sim | Percentual de umidade do solo (0 a 100) |
| `nivel_agua` | Float | Sim | Percentual do nível do reservatório de água (0 a 100) |
| `rele_bomba` | Boolean | Sim | Estado atual do relé (`true` = ligado, `false` = desligado) |
| `data_hora` | String | Não | Data/hora da leitura no formato ISO 8601 / ATOM |

#### Respostas
- **`200 OK`**:
  ```json
  {
    "sucesso": true,
    "mensagem": "Leitura registrada"
  }
  ```
- **`404 Not Found`**: Dispositivo não cadastrado ou inativo.
- **`422 Unprocessable Entity`**: Validação de parâmetros inválida ou incompleta.

---

### 2. Consulta de Comandos Pendentes
Utilizado pelo microcontrolador periodicamente (polling) para verificar se há instruções de acionamento pendentes.

- **URL**: `/api/comando.php?dispositivo_id=ESP32_PLANTA_01`
- **Método**: `GET`
- **Headers**:
  - `Authorization: Bearer <API_TOKEN>`

#### Respostas
- **Com comando pendente (`200 OK`)**:
  ```json
  {
    "sucesso": true,
    "comando": "ligar_bomba",
    "comando_id": 15,
    "criado_em": "2026-09-21 18:32:10"
  }
  ```
- **Sem comandos pendentes (`200 OK`)**:
  ```json
  {
    "sucesso": true,
    "comando": null
  }
  ```

> [!NOTE]
> Comandos pendentes com mais de **10 minutos** (`COMANDO_EXPIRA_MINUTOS`) são automaticamente marcados como `expirado`.

---

### 3. Confirmação de Execução de Comando
Chamado pelo microcontrolador após aplicar o comando no relé da bomba, finalizando o ciclo de vida do comando.

- **URL**: `/api/confirmar-comando.php`
- **Método**: `POST`
- **Headers**:
  - `Content-Type: application/json`
  - `Authorization: Bearer <API_TOKEN>`

#### Corpo da Requisição (JSON)
```json
{
  "dispositivo_id": "ESP32_PLANTA_01",
  "comando_id": 15,
  "rele_bomba": true
}
```

#### Respostas
- **`200 OK`**:
  ```json
  {
    "sucesso": true,
    "mensagem": "Comando confirmado"
  }
  ```
- **`404 Not Found`**: Comando não encontrado, já processado ou não pertencente ao dispositivo.

---

### 4. Criação de Novo Comando
Utilizado pelo painel administrativo ou aplicativo móvel para enviar uma ordem de acionamento para o dispositivo.

- **URL**: `/api/criar-comando.php`
- **Método**: `POST`
- **Headers**:
  - `Content-Type: application/json`
  - `Authorization: Bearer <API_TOKEN>`

#### Corpo da Requisição (JSON)
```json
{
  "dispositivo_id": "ESP32_PLANTA_01",
  "comando": "ligar_bomba"
}
```
*Valores aceitos em `comando`*: `"ligar_bomba"` ou `"desligar_bomba"`.

#### Respostas
- **`200 OK`**:
  ```json
  {
    "sucesso": true,
    "mensagem": "Comando criado",
    "comando_id": 16
  }
  ```

---

## 🚀 Como Configurar e Executar

### Pré-requisitos
- PHP 8.0 ou superior instalado.
- Servidor MySQL / MariaDB ativo.

### Passo a Passo

1. **Clonar o Repositório**:
   ```bash
   git clone https://github.com/miqueas-cdm/drop_of_water_projeto_Luan.git
   cd drop_of_water_projeto_Luan
   ```

2. **Configurar o Banco de Dados**:
   - Crie o banco de dados no seu MySQL.
   - Execute o script SQL fornecido na seção [Estrutura do Banco de Dados](#-estrutura-do-banco-de-dados).
   - Insira um dispositivo de teste:
     ```sql
     INSERT INTO devices (device_code, name, active) VALUES ('ESP32_PLANTA_01', 'Vaso Sala', 1);
     ```

3. **Configurar as Credenciais**:
   - Abra o arquivo [api/config.php](file:///api/config.php) e ajuste as constantes de conexão com o banco e token de autenticação:
     ```php
     const DB_HOST = 'localhost';
     const DB_NAME = 'nome_do_seu_banco';
     const DB_USER = 'seu_usuario';
     const DB_PASS = 'sua_senha';
     const API_TOKEN = 'seu_token_secreto';
     ```

4. **Executar o Servidor Embutido do PHP (Ambiente Local/Desenvolvimento)**:
   ```bash
   php -S localhost:8000
   ```
   Acesse no navegador: `http://localhost:8000`

---

## 💡 Exemplo de Integração (ESP32 / C++)

Trecho ilustrativo em C++ para microcontroladores ESP32 usando `HTTPClient`:

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char* serverUrl = "http://seu-servidor.com/api/leituras.php";
const char* apiToken = "Bearer xXVEua9xSmVi2C7TYb64Bs2DotJJFdyp";

void enviarLeitura(float umidadeSolo, float nivelAgua, bool statusBomba) {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", apiToken);

    StaticJsonDocument<200> doc;
    doc["dispositivo_id"] = "ESP32_PLANTA_01";
    doc["umidade_solo"] = umidadeSolo;
    doc["nivel_agua"] = nivelAgua;
    doc["rele_bomba"] = statusBomba;

    String requestBody;
    serializeJson(doc, requestBody);

    int httpResponseCode = http.POST(requestBody);
    if (httpResponseCode > 0) {
      String response = http.getString();
      Serial.println(response);
    }
    http.end();
  }
}
```

---

## 👥 Autores & Contexto

- **Projeto Integrador III**
- **Desenvolvido para**: Sistema Drop of Water
- **Repositório**: [drop_of_water_projeto_Luan](https://github.com/miqueas-cdm/drop_of_water_projeto_Luan)
