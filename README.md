# Drop of Water — API REST

API Node.js para a comunicação ESP32 → MySQL → app web, com autenticação por dispositivo, JWT para usuários e painel administrativo. Interface em HTML, CSS e JavaScript puro; compatível com Node.js 20+ e o Web App Node.js da Hostinger.

## Rodar localmente

1. Instale Node.js 20+ e MySQL 8 ou MariaDB compatível.
2. Crie um banco e copie `.env.example` para `.env`. Preencha as credenciais localmente; nunca envie `.env` ao Git.
3. Configure `JWT_SECRET` com pelo menos 32 bytes aleatórios e um `ADMIN_PASSWORD` com pelo menos 12 caracteres. O administrador inicial é criado na primeira inicialização.
4. Execute:

   ```sh
   npm install
   npm start
   ```

As tabelas são criadas automaticamente. Verifique `http://localhost:3000/api/v1/health`, abra `/admin/` para entrar e `/tester/` para validar a integração. `npm test` executa testes unitários e HTTP com banco simulado; `npm run test:integration` usa as variáveis `TEST_DB_*` e um banco de teste MySQL separado.

## Criar e usar um dispositivo

1. Entre em `/admin/`, crie um dispositivo e, se necessário, vincule-o a um usuário.
2. Copie a `device_key` exibida: ela é mostrada uma única vez. O servidor guarda somente seu hash SHA-256. Se perder a chave, rotacione-a.
3. Configure `DEVICE_ID`, `DEVICE_KEY`, Wi-Fi e certificado CA no sketch [esp32_drop_of_water.ino](./examples/esp32/esp32_drop_of_water.ino). Para testes locais, o sketch mostra a opção `setInsecure()` comentada; **não a habilite em produção**.
4. Use `api.http` ou `/tester/`. O ESP32 envia `X-Device-Id` e `X-Device-Key`; a chave nunca deve ir na URL. No GET, cada tentativa precisa de timestamp Unix e nonce novos.

O firmware deve configurar timeout de 15 segundos e tentar novamente até três vezes. O Web App da Hostinger pode pausar quando não há tráfego, portanto a primeira requisição pode demorar. O GET `/device/ingest` altera o estado e foi mantido por compatibilidade com firmware: isso foge da semântica HTTP normal de GET. Prefira POST quando puder atualizar o firmware.

### URLs do ESP32

Para a API em `dropofwater.miqtav.com`, use:

```cpp
const char* URL_POST_LEITURAS = "https://dropofwater.miqtav.com/api/v1/device/telemetry";
const char* URL_GET_COMANDO = "https://dropofwater.miqtav.com/api/v1/device/commands";
```

Em ambas as requisições, envie `X-Device-Id: DEVICE_ID` e `X-Device-Key: DEVICE_KEY` como cabeçalhos, substituindo pelos valores cadastrados no painel. Não acrescente `dispositivo_id` à URL nem use o token da antiga API PHP: as credenciais e rotas são diferentes. O POST também precisa de `Content-Type: application/json` e de um corpo como `{"temp":24.5,"hum":61.2,"bat":92}`. O GET retorna `{"commands":[{"id":1,"command":"status"}]}` quando há um comando pendente; após executá-lo, confirme-o pela rota de ack. Veja o sketch completo para HTTPS, leitura e confirmação.

### Modo temporário de teste sem chave

Por padrão a chave continua obrigatória. Para testes temporários, configure `ALLOW_UNAUTHENTICATED_DEVICE_ACCESS=true` no ambiente do servidor e reinicie a aplicação. O dispositivo ainda precisa estar cadastrado e ativo. Substitua `SEU_ID` pelo ID do dispositivo:

```cpp
const String URL_GET_COMANDO = "https://dropofwater.miqtav.com/api/v1/device/commands?dispositivo_id=" + String(DEVICE_ID);
const String URL_POST_LEITURAS = "https://dropofwater.miqtav.com/api/v1/device/telemetry?dispositivo_id=" + String(DEVICE_ID);
```

O POST continua exigindo JSON e `Content-Type: application/json`. Para confirmar um comando sem chave, use `GET /api/v1/device/commands/ack?dispositivo_id=SEU_ID&id=1&status=done` ou `POST /api/v1/device/commands/1/ack?dispositivo_id=SEU_ID` com `{"status":"done"}`. Também é possível usar `GET /api/v1/device/ingest?dispositivo_id=SEU_ID&temp=24.5&ts=TIMESTAMP_UNIX&nonce=NONCE_NOVO`; as opções `allow_get` e `require_nonce` do dispositivo continuam valendo.

No sketch de exemplo, ative `USE_UNAUTHENTICATED_TEST_ACCESS` para usar esse modo. A configuração remota permanece protegida e não é consultada nesse caso; o sketch usa o intervalo padrão de 60 segundos.

**Atenção:** com esse modo ativo em um site público, qualquer pessoa que saiba ou adivinhe o ID pode enviar dados, ler comandos e confirmá-los; consultar comandos altera seu estado. Não o use com equipamentos reais. Após os testes, defina `ALLOW_UNAUTHENTICATED_DEVICE_ACCESS=false` ou remova a variável e reinicie. Rotas de usuário e administração continuam protegidas.

## Rotas

- Público: `GET /api/v1/health`, `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/admin/login`.
- Dispositivo: `GET /device/ping`, `/config`, `/commands`, `/commands/ack`, `/ingest`; `POST /device/telemetry` e `/device/commands/:id/ack`.
- App: `GET /devices`, `/devices/:id`, `/devices/:id/telemetry`, `/devices/:id/telemetry/latest`; `POST /devices/:id/commands`.
- Admin: usuários, dispositivos, vínculos, `GET /admin/stats`, `/admin/logs`, `/admin/audit`.

Todos os caminhos acima são relativos a `/api/v1`. A lista completa de exemplos está em [api.http](./api.http).

## Segurança e [OWASP API Security Top 10 (2023)](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)

- **API1 — Broken Object Level Authorization:** consultas do app sempre verificam vínculo usuário-dispositivo; recurso não autorizado retorna 404.
- **API2 — Broken Authentication:** bcrypt com fator 12, JWT HS256 de 1 hora, chave aleatória de 256 bits armazenada como SHA-256, comparação em tempo constante e bloqueio de admin após cinco falhas por 15 minutos.
- **API3 — Broken Object Property Level Authorization:** Zod estrito rejeita campos extras; as respostas não expõem hash, chave, senha ou campos de autenticação.
- **API4 — Unrestricted Resource Consumption:** limite de 10 KB no corpo, limite de URL/contagem de parâmetros do GET, paginação limitada e rate limits para login, dispositivo e leitura do app.
- **API5 — Broken Function Level Authorization:** rotas administrativas exigem JWT `admin`; rotas do app aceitam apenas JWT `user`; dispositivos usam cabeçalhos próprios.
- **API6 — Unrestricted Access to Sensitive Business Flows:** envio de comandos exige autenticação e vínculo; criação/rotação de credenciais é administrativa e auditada; rate limits reduzem abuso automatizado.
- **API7 — Server Side Request Forgery:** a API não realiza requisições HTTP para destinos fornecidos pelo usuário (não aplicável aos fluxos implementados).
- **API8 — Security Misconfiguration:** Helmet, CORS com allowlist, HTTPS atrás do proxy, erros genéricos, segredo por ambiente, sem stack trace e sem query string nos logs.
- **API9 — Improper Inventory Management:** API versionada em `/api/v1`, inventário de endpoints em `api.http` e documentação de deploy.
- **API10 — Unsafe Consumption of APIs:** não há consumo de APIs de terceiros; payloads recebidos são validados antes do uso.

Esta implementação cobre controles relevantes para o escopo descrito; não representa certificação nem substitui revisão de segurança e configuração do ambiente.

## Design

Referências: [Taste Skill](https://github.com/Leonxlnx/taste-skill) e [Web Design Rules and Guidelines](https://github.com/abbas-roholamin/web-design-rules-and-guidelines). As interfaces aplicam uma direção minimalista de software, com escala tipográfica curta, hierarquia explícita, contraste acessível, conteúdo alinhado, espaços em múltiplos de 8 px, formulários com rótulos e feedback, interação reduzida e layout responsivo. O azul, verde e amarelo da paleta brasileira são usados como navegação, sucesso e destaque, sem competir com os dados.

