# Módulo: segurança da cadeia de instalação

Registro do script npm que não faz parte do produto WhatsApp. O detalhe do incidente, os indicadores e a remediação do servidor estão no log semanal.

## Dependências de desenvolvimento

`deepmerge` não entra no processo do WhatsApp. O `npm audit` só o vê via `jest-config` e `swagger-autogen`. Não há release corrigida depois de 4.3.1. O override vigente é a versão exata `4.1.2` (última fora do intervalo GHSA-gcqx-w48m-w2h4). Não rebaixar `jest` para 25.1.0 nem `swagger-autogen` para 2.7.7: o primeiro é downgrade da 29.7.0 e o segundo quebra a geração OpenAPI 3 de `swagger.js`.

Instalação deste repositório continua com `npm install --ignore-scripts`.

## Histórico de Modificações Recentes

- `../2026/11/semana-46/12112026_melhoria_audit_jest_swagger.md`
- `../2026/11/semana-45/06112026_melhoria_npm_audit_transitivas.md`
- `../2026/11/semana-45/02112026_seguranca_postinstall-malicioso.md`
