# Correção: erro "Execution context was destroyed" no initialize do Client

**Data:** 09/04/2026  
**Tipo:** `fix_` — integração whatsapp-web.js / Puppeteer  

## Contexto

Durante `client.initialize()`, a biblioteca injeta scripts via `page.evaluate`. Se o WhatsApp Web redirecionar ou recarregar nesse intervalo, o Puppeteer lança `Execution context was destroyed, most likely because of a navigation` e o processo Node pode encerrar.

## O que foi feito

- Retentativas configuráveis em `src/sessions.js` ao chamar `initialize()`, com backoff exponencial.
- Novas variáveis de ambiente (com defaults seguros): `CLIENT_INITIALIZE_MAX_RETRIES`, `CLIENT_INITIALIZE_RETRY_BASE_MS` em `src/config.js` e documentadas em `.env.example`.
- Em cada falha retentável: `client.destroy()` e novo `Client` na próxima tentativa, evitando instância inconsistente.

## Operação (SaaS / deploy)

Ajustar por ambiente conforme latência e carga; em servidores lentos ou rede instável, aumentar `CLIENT_INITIALIZE_MAX_RETRIES` ou a base de delay pode reduzir falhas intermitentes.

## Histórico de Modificações Recentes

- Entrada inicial: retentativas para erros transitórios do Puppeteer no setup da sessão.
