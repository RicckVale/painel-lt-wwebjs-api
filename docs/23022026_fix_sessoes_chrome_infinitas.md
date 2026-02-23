# Fix: Sessões Chrome Infinitas no Servidor

**Data:** 23/02/2026  
**Tipo:** fix  
**Módulo:** sessions (src/sessions.js)  
**Severidade:** Crítica

## Problema

A API estava criando processos Chrome infinitamente no servidor, consumindo toda a memória e CPU. O `htop` mostrava dezenas de processos `chrome --type=renderer` rodando simultaneamente para a mesma sessão.

### Logs do Erro

```
"Session is being initiated" (mesmo sessionId, múltiplas vezes)
"Browser lock file exists, removing"
"The browser is already running for .../sessions/session-XXX. Use a different userDataDir"
```

## Causa Raiz (5 falhas identificadas)

### 1. Race Condition na Inicialização
A sessão só era adicionada ao `Map` **após** `client.initialize()` completar (que leva vários segundos lançando o Chrome). Durante esse tempo, novas chamadas para o mesmo `sessionId` passavam na verificação `sessions.has(sessionId)` e lançavam **mais processos Chrome**.

### 2. Loop Infinito de Recovery
Com `RECOVER_SESSIONS=TRUE`, os handlers de `close`/`error` da página chamavam `restartSession` que fazia `destroy() + setupSession()`. Se a inicialização falhava, a página fechava, disparando novamente o handler, criando um loop infinito.

### 3. Remoção Indevida do Browser Lock
O `releaseBrowserLock` removia o `SingletonLock` **mesmo quando o browser ainda estava rodando**, permitindo que outro Chrome usasse o mesmo diretório de dados.

### 4. Sem Cleanup ao Falhar
Quando `client.initialize()` falhava, o processo Chrome parcialmente iniciado **nunca era encerrado** (kill).

### 5. Sem Controle de Concorrência
Nenhum mecanismo de lock impedia operações concorrentes (start, stop, restart) na mesma sessão.

## Correções Aplicadas

### A. Tracking de estado "pendente" (`pendingSessions`)
- Adicionado `Set` para rastrear sessões em processo de inicialização
- `setupSession()` agora rejeita imediatamente se a sessão já está sendo inicializada

### B. Limite de restart com cooldown (`canRestart`)
- Máximo de **3 tentativas** de restart por sessão em uma janela de **2 minutos**
- Cooldown de **30 segundos** entre tentativas
- Contador reseta automaticamente quando a sessão conecta com sucesso (`ready`)

### C. Lock por sessão (`acquireSessionLock`)
- Mutex simples por sessionId para serializar operações concorrentes
- Aplicado em: `reloadSession`, `destroySession`, `deleteSession`, e recovery automático

### D. Cleanup forçado de processos Chrome (`killBrowserProcess`)
- Função dedicada para matar processos Chrome órfãos via `SIGKILL`
- Chamada em: falha de inicialização, falha de destroy graceful, e abort de recovery

### E. Remoção inteligente do browser lock
- Agora verifica se a sessão está ativa antes de remover o `SingletonLock`
- Só remove se a sessão não existir no Map (lock realmente stale)

## Arquivos Modificados

| Arquivo | Alteração |
|---------|-----------|
| `src/sessions.js` | Todas as correções acima |

## Correção Adicional: Rota `terminateInactive` não matava processos órfãos

### Problema
A rota `GET /session/terminateInactive` retornava `"Flush completed successfully"` sem realmente matar nenhum processo Chrome órfão. O fluxo era:
1. `flushSessions(true)` lia pastas do disco
2. Para sessão sem entrada no Map → `validateSession` retornava `session_not_found`
3. `deleteSession` verificava `sessions.get(sessionId)` → null → **retornava imediatamente**
4. Processos Chrome continuavam rodando indefinidamente

### Correção
- Adicionada função `killOrphanedBrowserByLockFile()` que lê o `SingletonLock` (symlink do Chrome que contém hostname-PID), localiza o processo pelo PID e faz `SIGKILL`
- `deleteSession` e `destroySession` agora chamam essa função quando não encontram client no Map, ao invés de retornar silenciosamente
- `flushSessions` agora loga contagem de sessões encerradas vs mantidas

## Impacto

- Elimina criação infinita de processos Chrome
- Rota `terminateInactive` agora realmente mata processos Chrome órfãos
- Servidor mantém uso estável de memória e CPU
- Sessões se recuperam de forma controlada (máximo 3 tentativas)
- Operações concorrentes na mesma sessão são serializadas
