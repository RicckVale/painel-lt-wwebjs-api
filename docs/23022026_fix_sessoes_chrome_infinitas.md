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

## Correção 3: `terminateInactive` matava sessões conectadas

### Problema
Ao rodar `terminateInactive`, sessões que estavam conectadas também eram derrubadas. Duas causas:

1. **PID reutilizado pelo SO (Linux):** A função `killOrphanedBrowserByLockFile` lia o PID do `SingletonLock` de uma sessão órfã. Mas o Linux recicla PIDs. Se o PID antigo agora pertencia ao Chrome de uma sessão ATIVA, ela era morta por engano.

2. **`flushSessions` tratava igual sessões órfãs e sessões no Map:** Ambas passavam por `validateSession` → `deleteSession`, mas `validateSession` pode falhar temporariamente para sessões ocupadas (timeout no `getState()`), causando destruição indevida.

### Correção
- `killOrphanedBrowserByLockFile` agora faz **3 verificações** antes de matar:
  1. Verifica se o PID pertence a uma sessão ativa no Map (`getActiveBrowserPids`)
  2. Lê `/proc/PID/cmdline` para confirmar que é Chrome
  3. Verifica se o cmdline contém o caminho da sessão específica
- `flushSessions(deleteOnlyInactive=true)` agora separa claramente:
  - **Sessões órfãs** (pasta existe, sem client no Map): limpa lock file e pasta
  - **Sessões no Map não conectadas**: destrói via referência do client (seguro)
  - **Sessões no Map conectadas**: pula sem tocar

## Impacto

- Elimina criação infinita de processos Chrome
- Rota `terminateInactive` mata SOMENTE processos Chrome genuinamente órfãos
- Sessões conectadas nunca são afetadas pelo flush
- Servidor mantém uso estável de memória e CPU
- Sessões se recuperam de forma controlada (máximo 3 tentativas)
- Operações concorrentes na mesma sessão são serializadas
