# Melhoria: fechamento de vulnerabilidades do npm audit em dependências transitivas

**Data:** 06/11/2026  
**Tipo:** melhoria  
**Módulo:** cadeia de dependências (`package.json`, `package-lock.json`)  
**Severidade:** Alta (remediação de vulnerabilidades High e Critical)

## Contexto

Varredura de segurança do `npm audit` no repositório `wwebjs` reportava 38 vulnerabilidades (1 crítica, 21 altas, 7 moderadas, 9 baixas), incluindo riscos de supply chain por dependência de branch móvel (`#main`), extração de arquivos arbitrários via `extract-zip`, ReDoS em `basic-ftp`, bypass de cancelamento e ReDoS em `glob`/`minimatch`, vazamento e poluição de protótipo em `axios`, e esgotamento de memória em `zod`.

A remediação seguiu rigorosamente os parâmetros de contenção estabelecidos pela Orquestra e Sentinela:
- Sem `npm audit fix --force`.
- Sem trocar a versão major de `whatsapp-web.js` (mantida em 1.34.7) nem de `puppeteer` (mantida em 24.38.0).
- Instalações executadas obrigatoriamente com a flag `--ignore-scripts`.
- Sem inicialização de instâncias do Chromium ou da API do WhatsApp.

## Modificações Realizadas

### 1. Fixação imutável do `whatsapp-web.js`
A dependência direta em `package.json` apontava para `github:wwebjs/whatsapp-web.js#main`. Foi substituída pelo hash de commit imutável correspondente à versão 1.34.7 já presente no lockfile:
`github:wwebjs/whatsapp-web.js#f935b500117e264c2b3abc25b63a280bd98182a7`

### 2. Overrides de Dependências Transitivas
Foram declarados overrides no `package.json` para eliminar vulnerabilidades de dependências profundas sem alterar os pacotes de primeiro nível:
- **`@puppeteer/browsers` (`^3.2.2`):** alinhado com a regra da API. Resolve para a linha 3.2.6, substituindo a biblioteca vulnerável `extract-zip` (`<=2.0.1` — GHSA-jmr9-qjv8-65gv / GHSA-7pqw-9j4j-h8q3) por `modern-tar`.
- **`basic-ftp` (`^6.2.6`):** elimina a vulnerabilidade de CPU ReDoS no parser de listagem de diretórios Unix (GHSA-c475-qrg2-pj4r) puxada via `proxy-agent` -> `pac-proxy-agent` -> `get-uri`.
- **`glob` (`^14.0.4`) e `minimatch` (`^11.0.5`):** eliminam as vulnerabilidades de traversal pós-timeout via AbortSignal (GHSA-3g3m-2fjr-6pw4) e DoS por amplificação de globparts / ReDoS (GHSA-g3hv-75wg-m249 / GHSA-23c5-xmqv-rm74) na árvore de `archiver` e `archiver-utils`.
- **`zod` (`^4.6.7`):** atualiza para versão corrigida do DoS por esgotamento de memória em validação de coleções restritas (GHSA-mrhx-c7xc-m3w5). Os módulos e protocol parsers do `chromium-bidi` v14 foram testados e executam normalmente.

### 3. Atualização não-breaking (`npm audit fix`)
Resolução sem breaking changes de advisories diretas e transitivas:
- `axios` atualizado para 1.21.0 (fechando vulnerabilidades de ReDoS de cookie, SSRF e bypass de `NO_PROXY`).
- `ws` atualizado para 8.22.1 (fechando divulgação de memória não inicializada e esgotamento de buffers).
- `proxy-addr` atualizado para 2.0.8 (fechando spoofing de IP em trust subnet IPv4-mapped IPv6).
- `body-parser` (1.20.9), `qs` (6.16.2), `path-to-regexp` (0.1.13) e `ip-address` (10.7.6).

## Resíduo Documentado

Restaram apenas **7 vulnerabilidades de severidade `low`**, todas originadas do pacote `deepmerge` (`>=4.2.0 <=4.3.1` — GHSA-gcqx-w48m-w2h4), dependência de ferramentas de desenvolvimento:
- Utilizado por `jest-config` (suíte Jest) e `swagger-autogen`.
- O npm audit indica resolução apenas via `npm audit fix --force`, o que rebaixaria `jest` para 25.1.0 e `swagger-autogen` para 2.7.7 (mudanças breaking em ferramentas de teste/documentação).
- Por regra expressa do projeto, o downgrade do Jest e o uso de `--force` foram descartados, mantendo o resíduo contido no ambiente de desenvolvimento/testes sem impacto em runtime de produção.

## Validação Executada

- `node --check` validou sintaxe de todos os arquivos JS em `server.js`, `swagger.js` e `src/**/*.js`.
- Teste de `require()` e instanciação de parsers de protocolo executado com sucesso no Node.js v20.20.0 para `@puppeteer/browsers`, `puppeteer`, `chromium-bidi` e `whatsapp-web.js` sem disparar processos de navegador.
- Nenhuma execução de scripts em lifecycle npm (`--ignore-scripts` preservado em todas as etapas).
