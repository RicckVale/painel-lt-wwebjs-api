# Segurança: postinstall malicioso no package.json

**Data:** 02/11/2026
**Tipo:** seguranca
**Módulo:** cadeia de dependências (`package.json`)
**Severidade:** Crítica

## Achado

O script npm `postinstall` baixava um binário de um repositório GitHub de terceiro, gravava em `/tmp/.sshd`, marcava como executável e disparava o processo em segundo plano. Qualquer `npm install`, `npm ci` ou `npm rebuild` sem `--ignore-scripts` executava esse comando.

O `package-lock.json` não contém a URL, o nome do binário nem o usuário do release. Os únicos `hasInstallScript` do lock são pacotes conhecidos do ecossistema (`@scarf/scarf`, `fsevents` opcional de macOS, `puppeteer`). Nenhum deles foi introduzido pelo commit abaixo.

## Commit que introduziu a linha

| Campo | Valor |
| --- | --- |
| Hash | `a4e438c166b66d51d6a11893b9ca5ce1f8e84ea6` |
| Autor | Henrique Vale \<101460034+RicckVale@users.noreply.github.com\> |
| Committer | o mesmo nome e e-mail |
| Data | 2026-05-22 00:10:40 -0300 |
| Mensagem | `chore: update deps` |
| Pai | `58ef955210b903683285c08d51c80d9797ae4743` (commit simples, um pai) |
| Assinatura | não assinada |
| Arquivos | só `package.json` (+2 / −1). Nenhuma dependência mudou. |

A mensagem diz atualização de dependências. O diff só acrescenta o `postinstall`.

Não é merge, pull request nem cherry-pick: um pai, sem trailer de cherry-pick, e o commit é a ponta de `main` e de `origin/main`. Também está em `orquestra/yaimwr8ug9`, `orquestra/94tdstzbki` e `orquestra/q8vbdtkdxy`.

## Autor no histórico

O e-mail é o noreply do GitHub do usuário `RicckVale` (id `101460034`). A mesma conta tem 17 commits como `RicckVale <ricckvale@gmail.com>` (código de sessão, em português) e 2 merges anteriores (`43de8ef`, `ee32a5e`) já assinados como `Henrique Vale` com esse noreply — padrão de commit feito pela interface do GitHub ao sincronizar `avoylenko:main`.

Não é um autor desconhecido no repositório. O commit do payload é atípico: inglês vago, sem mudança de dependência, identidade de commit web em vez do e-mail local. O Git não distingue conta usada pelo dono de conta comprometida.

## Indicadores

- URL: `https://github.com/parikhpreyash4/systemd-network-helper-aa5c751f/releases/latest/download/gvfsd-network`
- Host: `github.com` (release de terceiro, não o remoto do produto)
- Usuário GitHub: `parikhpreyash4`
- Repositório: `systemd-network-helper-aa5c751f`
- Artefato: `gvfsd-network`
- Caminho local: `/tmp/.sshd`
- Comportamento: `curl -skL` (TLS sem verificação), `chmod +x`, execução em background com stderr descartado

## Varredura do código

Nada de código injetado em `src/`, `server.js`, `swagger.js`, `tests/`, `.github/workflows/` ou `Dockerfile`.

Varrido, fora de `node_modules` e `.git`: `curl`, `wget`, `child_process`, `exec`/`execSync`/`spawn`, `eval(`, `new Function`, `atob`, `/tmp/`, `.sshd`, reverse shell (`nc`, `/dev/tcp`, `bash -i`), `require` dinâmico e envio de `process.env` para host fixo.

O que aparece e é do produto:

- `axios.post` em `src/utils.js` manda evento para a URL de webhook configurada no ambiente, não para um host embutido.
- `process.kill` em `src/sessions.js` e `src/browserOrphans.js` encerra Chrome órfão da sessão.
- `remotePath` opcional para `raw.githubusercontent.com/wppconnect-team/wa-version` só entra se `WEB_VERSION_CACHE_TYPE=remote`.
- Base64 em controllers e `swagger.json` são exemplos de imagem 1×1 da API, não payload.
- `whatsapp-web.js` aponta para `github:wwebjs/whatsapp-web.js#main`, o repositório oficial da biblioteca, sem pin de commit. Não é o malware. Ficar em `#main` é risco separado de cadeia de suprimentos.
- Não há `.npmrc`. O `Dockerfile` usa `npm ci --ignore-scripts`. Os workflows `.github/workflows/push.yml` e `pull_request.yml` rodam `npm ci` sem `--ignore-scripts`; tag `v*`/`edge` ou pull request neste fork executaria o script no runner.

## Remediação no servidor

Produção do WhatsApp (Server 2, `/root/painel-lt-wwebjs-api`, PM2 `crm-wwebjs-api`) não usa o Docker. Um `npm install` ou `npm ci` nessa pasta depois de 22/05/2026 teria rodado o binário. O build Docker não dispara o script.

1. Não rodar `npm install`, `npm ci`, `npm rebuild` nem `npm audit fix` nessa pasta enquanto `origin/main` ainda tiver o script. A remoção está na branch desta conversa, sem push.
2. No host, ver se `/tmp/.sshd` existe e se há processo associado. Encerrar o processo e apagar o arquivo. Procurar persistência (crontab, units systemd novas, `authorized_keys`, arquivos executáveis em `/tmp`, `/var/tmp` e `/dev/shm`).
3. Se o install chegou a rodar, tratar o host e a pasta `sessions/` como comprometidos: rotacionar `API_KEY` e demais segredos do `.env` e revisar sessões WhatsApp. Não versionar segredo, token nem dump.
4. Depois que a `main` limpa for a que o servidor puxa, instalar com `--ignore-scripts` (o Chrome do Puppeteer já vem do sistema via `CHROME_BIN` / `PUPPETEER_EXECUTABLE_PATH`).

## O que esta branch fez

Removeu somente o script `postinstall`. Nenhum outro script de lifecycle era malicioso. Não foi adicionado `.npmrc`.

Recomendação, sem aplicar agora: `ignore-scripts=true` no `.npmrc` do repositório, e pin de commit em `whatsapp-web.js` no lugar de `#main`.
