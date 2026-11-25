# Deploy na Hostinger (Node.js Web App)

1. **Criar o MySQL no hPanel.** Em Bancos de dados → MySQL, crie o banco e o usuário; anote nome, usuário e senha em um gerenciador seguro. Conceda ao usuário acesso ao banco. O servidor cria as tabelas ao iniciar.
2. **Criar o Web App Node.js.** No hPanel, crie um Web App Node.js via GitHub ou envie um ZIP do projeto. Não inclua `node_modules`, `.env` ou arquivos de credenciais.
3. **Configurar inicialização e ambiente.** Defina `server.js` como arquivo de entrada e selecione Node.js 20 ou superior. Cadastre no painel as variáveis de `.env.example`: `PORT`, `NODE_ENV=production`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` e `ALLOWED_ORIGINS`. Use uma chave JWT com pelo menos 32 bytes aleatórios, uma senha admin forte (12+ caracteres) e a origem completa do site, por exemplo `https://seu-dominio.example`. Não coloque valores secretos no código.
4. **Instalar e iniciar.** Use a opção de instalação do hPanel (`npm install`) e inicie/reinicie o Web App. O comando de inicialização do projeto é `npm start` (`node server.js`). Confira os logs do processo no hPanel se o serviço não iniciar.
5. **Verificar.** Acesse `https://seu-dominio.example/api/v1/health`; a resposta esperada é `{"status":"ok","db":"ok"}`. Abra `/tester/`, entre como admin e execute o checklist. No primeiro acesso após inatividade, aguarde: a hospedagem pode suspender o processo sob demanda.
6. **Domínio e SSL.** Aponte o domínio ao Web App, aguarde a propagação e confirme no hPanel que o certificado SSL está ativo. A aplicação redireciona HTTP para HTTPS quando o proxy informa `x-forwarded-proto: http`.

## Após o deploy

- Cadastre o domínio/origem exata em `ALLOWED_ORIGINS` (separe várias origens com vírgula) e reinicie o app.
- Crie dispositivos no `/admin/`, copie a chave uma única vez e atualize o firmware.
- Configure o ESP32 com timeout de 15 s, até três tentativas e a CA que valida o domínio. Não use `setInsecure()` em produção.
- O MySQL pode encerrar conexões ociosas; o pool da aplicação adquire conexões novamente sob demanda.
- Faça backup do banco. Revogue/rotacione imediatamente qualquer senha ou chave exposta.
- Somente para testes temporários sem chave, defina `ALLOW_UNAUTHENTICATED_DEVICE_ACCESS=true` nas variáveis do Node.js no hPanel e reinicie. Isso expõe leituras e comandos de dispositivos a qualquer pessoa que saiba o ID; desative após o teste. Veja as URLs e os riscos no README.
