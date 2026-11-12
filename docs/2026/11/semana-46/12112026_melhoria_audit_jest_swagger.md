# Melhoria: sete achados low de Jest e swagger-autogen

**Data:** 12/11/2026  
**Tipo:** melhoria  
**Módulo:** cadeia de dependências de desenvolvimento (`package.json`, `package-lock.json`)  
**Severidade:** Baixa (ferramentas de teste e geração de OpenAPI; não entram no runtime do WhatsApp)

## Problema

O `npm audit` do `wwebjs` ainda reportava 7 vulnerabilidades `low`, todas no mesmo advisory: `deepmerge` `>=4.2.0 <=4.3.1` (GHSA-gcqx-w48m-w2h4, prototype poisoning no objeto devolvido por `mergeObject`). Não há versão publicada acima de 4.3.1.

O audit aponta correção só com downgrade, marcado como major:

| Pacote | Instalado | Alvo do audit |
| --- | --- | --- |
| `jest` (e `@jest/core`, `jest-cli`, `create-jest`, `jest-config`) | 29.7.0 | 25.1.0 |
| `swagger-autogen` | 2.23.7 (última no registro) | 2.7.7 |

`deepmerge` é dependência só de desenvolvimento: `jest-config` (globals de preset) e `swagger-autogen` (merge do spec local).

## O que mudou

### Jest 25.1.0 não foi aplicado

29.7.0 → 25.1.0 é downgrade. A linha 30 (última consultada: `jest@30.5.2` / `jest-config@30.5.2`) continua com `deepmerge: ^4.3.1`, ainda dentro do intervalo do advisory. Subir o Jest não fecha o achado.

`create-jest` e `jest-cli` permanecem em 29.7.0, a mesma linha do `jest`. Fixá-los por override na linha 25 arrastaria o downgrade do Jest. O override que corta a cadeia é o do `deepmerge`.

### swagger-autogen 2.7.7 foi instalado e revertido

2.7.7 é anterior a 2.23.7. Ela não depende de `deepmerge` e também não implementa a opção `openapi` que `swagger.js` usa (`{ openapi: '3.0.0', autoBody: false }`).

Com `swagger-autogen@2.7.7` e `npm install --ignore-scripts`, `node swagger.js` imprimiu `Failed` e `SyntaxError: Invalid or unexpected token` ao ler anotações das rotas (`content` / `application/json`). O processo ainda saiu com código 0, mas não reescreveu o spec. A versão foi devolvida para `^2.23.7`.

### Override de `deepmerge` em 4.1.2

`4.1.2` é a última publicação fora do intervalo `>=4.2.0 <=4.3.1`. O guard `propertyIsUnsafe`, que o advisory descreve como contornável, entrou na linha 4.2. Não existe release corrigida.

Em `package.json`:

```json
"deepmerge": "4.1.2"
```

Pin exato, sem `^`, para o lock não voltar a 4.2/4.3. Instalação com `npm install --ignore-scripts`. O pacote fica só em `dev` (`jest-config` e `swagger-autogen`).

## API e banco

Nenhuma rota, campo ou variável de ambiente mudou. `swagger.json` gerado de novo ficou idêntico ao que já estava no Git (OpenAPI `3.0.0`, 148 paths).

## Validação

- `npm install --ignore-scripts --no-audit --no-fund` após o override e de novo depois de reverter o `swagger-autogen`.
- `npm audit`: `found 0 vulnerabilities`.
- `node swagger.js` com `swagger-autogen@2.23.7` e `deepmerge@4.1.2`: `Success`. `swagger.json` idêntico ao backup (433461 bytes, `openapi` 3.0.0, 148 paths).
- `node swagger.js` com `swagger-autogen@2.7.7`: `Failed` / `SyntaxError` em `swagger-tags.js`. Salto revertido.
- Comparação do Jest no Node v20.20.0, mesmo comando nos dois casos: `/usr/bin/node node_modules/jest/bin/jest.js --runInBand --forceExit --watchman=false tests/api.test.js`.
  - Antes do override: `git checkout 2c0a2a6 -- package.json package-lock.json`, `npm install --ignore-scripts`, `deepmerge@4.3.1` (sem a chave no `overrides`). Saída: `FAIL tests/api.test.js`, `SyntaxError: Unexpected token 'export'` em `puppeteer-core/node_modules/@puppeteer/browsers/lib/main.js:6`, `Test Suites: 1 failed, 1 total`, `Tests: 0 total`, `EXIT:1`.
  - Com o override atual (`deepmerge@4.1.2`, arquivos devolvidos com `git checkout HEAD -- package.json package-lock.json` e novo `npm install --ignore-scripts`): a mesma mensagem, o mesmo arquivo e `EXIT:1`.
  - O erro já existia. Vem do Jest 29 carregando `@puppeteer/browsers@3.2.6` (ESM). O pin do `deepmerge` não entra nessa pilha. Os arquivos de dependência voltaram ao HEAD; nada desse checkout foi commitado.
