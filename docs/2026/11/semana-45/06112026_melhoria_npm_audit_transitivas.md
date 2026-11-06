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
- **`@puppeteer/browsers` (`3.2.6` fixo):** versão exata sem acento circunflexo largo, eliminando a dependência vulnerável `extract-zip` (`<=2.0.1` — GHSA-jmr9-qjv8-65gv / GHSA-7pqw-9j4j-h8q3) via `modern-tar`. *(Detalhes sobre Node 20 na seção abaixo)*.
- **`basic-ftp` (`^6.2.6`):** elimina a vulnerabilidade de CPU ReDoS no parser de listagem de diretórios Unix (GHSA-c475-qrg2-pj4r) puxada via `proxy-agent` -> `pac-proxy-agent` -> `get-uri`.
- **`glob` (`^14.0.4`) e `minimatch` (`^11.0.5`):** eliminam as vulnerabilidades de traversal pós-timeout via AbortSignal (GHSA-3g3m-2fjr-6pw4) e DoS por amplificação de globparts / ReDoS (GHSA-g3hv-75wg-m249 / GHSA-23c5-xmqv-rm74) na árvore de `archiver` e `archiver-utils`.
- **`zod` (`^4.6.7`):** atualiza para versão corrigida do DoS por esgotamento de memória em validação de coleções restritas (GHSA-mrhx-c7xc-m3w5). Os módulos e protocol parsers do `chromium-bidi` v14 foram testados e executam normalmente.

### 3. Atualização não-breaking (`npm audit fix`)
Resolução sem breaking changes de advisories diretas e transitivas:
- `axios` atualizado para 1.21.0 (fechando vulnerabilidades de ReDoS de cookie, SSRF e bypass de `NO_PROXY`).
- `ws` atualizado para 8.22.1 (fechando divulgação de memória não inicializada e esgotamento de buffers).
- `proxy-addr` atualizado para 2.0.8 (fechando spoofing de IP em trust subnet IPv4-mapped IPv6).
- `body-parser` (1.20.9), `qs` (6.16.2), `path-to-regexp` (0.1.13) e `ip-address` (10.7.6).

---

## Investigação Detalhada: `@puppeteer/browsers` e Compatibilidade com Node 20

A equipe de QA solicitou a verificação minuciosa dos campos `engines` e `dependencies` de todas as versões 3.x publicadas de `@puppeteer/browsers` (de 3.0.0 a 3.2.6) para identificar a maior versão que não dependesse de `extract-zip` e cujo `engines` aceitasse Node 20 (versão de produção).

### Levantamento no Registro Oficial NPM

A consulta direta ao registro do npm retornou o seguinte histórico para a linha 3.x e a linha 2.13.x:

| Versão | `engines.node` declarado | Depende de `extract-zip`? | Descompressor utilizado |
| :--- | :--- | :---: | :--- |
| `2.13.0` | `>=18` (aceita Node 20) | **Sim** (`^2.0.1`) | `extract-zip` + `tar-fs` |
| `2.13.1` | `>=18` (aceita Node 20) | **Sim** (`^2.0.1`) | `extract-zip` + `tar-fs` |
| `2.13.2` | `>=18` (aceita Node 20) | **Sim** (`^2.0.1`) | `extract-zip` + `tar-fs` |
| `3.0.0` / `3.0.1` | *(Não publicadas no npm)* | — | — |
| `3.0.2` | `>=22.12.0` | **Não** | `tar-fs` |
| `3.0.3` | `>=22.12.0` | **Não** | `tar-fs` |
| `3.0.4` a `3.2.6` | `>=22.12.0` | **Não** | `modern-tar` |

### Conclusão Técnica e Tratamento do Resíduo de Engine

1. **Inexistência de versão 3.x com `engines` para Node 20:** Ao saltar para a major 3, o upstream do Puppeteer elevou simultaneamente a exigência mínima de engine para `>=22.12.0` em **todas** as versões da série 3. Nenhuma versão 3.x aceita formalmente Node 20 no `package.json`.
2. **Dependência inevitável em 2.x:** Todas as versões da linha 2.x que aceitam Node 20 (`2.13.x`) dependem diretamente de `extract-zip: ^2.0.1`, que é o vetor de vulnerabilidade de alta gravidade sem correção na linha 2.
3. **Comportamento em Runtime no Node 20:** Em tempo de execução sob Node `v20.20.0`, `@puppeteer/browsers@3.2.6` não utiliza chamadas de sistema exclusivas do Node 22 que impeçam a execução. Os módulos `puppeteer`, `puppeteer-core` e `whatsapp-web.js` carregam com sucesso via `require()`. O único efeito colateral é o aviso não-bloqueante `EBADENGINE` emitido pelo gerenciador de pacotes npm durante a instalação.
4. **Fixação Exata:** Foi fixada a versão exata `"@puppeteer/browsers": "3.2.6"` no override do `package.json` (sem acento circunflexo `^`) para manter estabilidade absoluta do lockfile e garantir que `extract-zip` permaneça ausente da árvore de dependências (`npm ls extract-zip` retorna vazio).

---

## Resíduo Documentado

1. **Aviso `EBADENGINE` em Node 20**: Conforme detalhado acima, decorrente da exigência de `node >=22.12.0` em toda a major 3 do `@puppeteer/browsers`. Mantido para neutralizar o risco de segurança crítico/alto do `extract-zip`.
2. **7 vulnerabilidades `low` em `deepmerge` (`>=4.2.0 <=4.3.1` — GHSA-gcqx-w48m-w2h4)**: Dependência exclusiva de ferramentas de teste e geração de docs (`jest-config` e `swagger-autogen`). Não foi aplicado `--force` para evitar quebra com downgrade de `jest` para a v25 e `swagger-autogen` para a v2.7.7.

---

## Validação Executada

- `npm ls extract-zip`: Retorna `(empty)`, confirmando a eliminação completa da dependência vulnerável.
- `npm ls @puppeteer/browsers`: Confirma a versão fixada `3.2.6 overridden`.
- `node --check` validou sintaxe de todos os arquivos JS em `server.js`, `swagger.js` e `src/**/*.js`.
- Teste de `require()` executado com sucesso no Node.js v20.20.0 para `puppeteer` e `whatsapp-web.js` sem disparar processos de navegador.
- `--ignore-scripts` preservado em todas as etapas de `npm install`.
