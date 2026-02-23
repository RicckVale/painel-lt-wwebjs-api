# Módulo: Sessions (src/sessions.js)

## Visão Geral

Módulo responsável pelo ciclo de vida completo das sessões WhatsApp Web, incluindo criação, destruição, recovery e gerenciamento de processos Chrome/Puppeteer.

## Estruturas de Dados

| Estrutura | Tipo | Finalidade |
|-----------|------|------------|
| `sessions` | `Map<sessionId, Client>` | Sessões ativas e conectadas |
| `pendingSessions` | `Set<sessionId>` | Sessões em processo de inicialização (previne duplicatas) |
| `sessionLocks` | `Map<sessionId, boolean>` | Mutex por sessão para operações concorrentes |
| `restartAttempts` | `Map<sessionId, {count, firstAttempt, lastAttempt}>` | Controle de tentativas de recovery |

## Constantes de Configuração

| Constante | Valor | Descrição |
|-----------|-------|-----------|
| `MAX_RESTART_ATTEMPTS` | 3 | Máximo de tentativas de restart por janela |
| `RESTART_COOLDOWN_MS` | 30000 | Cooldown mínimo entre restarts (30s) |
| `RESTART_RESET_MS` | 120000 | Janela para resetar contador de restarts (2min) |

## Funções Principais

### `setupSession(sessionId)`
Inicializa uma sessão WhatsApp. Verificações antes de iniciar:
1. Sessão já existe no Map? → Retorna erro
2. Sessão está pendente (sendo inicializada)? → Retorna erro
3. Marca como pendente, inicializa Chrome, registra eventos
4. Em caso de falha: mata processo Chrome órfão e limpa estado

### `destroySession(sessionId)` / `deleteSession(sessionId, validation)`
Encerra sessão com lock de concorrência. Tenta destroy graceful primeiro, se falhar faz `SIGKILL` no processo Chrome.

### `reloadSession(sessionId)`
Reinicia sessão sem perder cache do browser. Usa lock para evitar operações concorrentes.

### `safeRestartSession(sessionId, reason)` (dentro de initializeEvents)
Recovery automático com proteções:
- Verifica limite de tentativas via `canRestart()`
- Usa lock para evitar restarts paralelos
- Aguarda 2 segundos entre destroy e re-criação

### `killBrowserProcess(client, sessionId)`
Força encerramento do processo Chrome via `SIGKILL` usando a referência do objeto client. Usado como fallback quando destroy graceful falha.

### `killOrphanedBrowserByLockFile(sessionId)`
Para sessões órfãs (sem client no Map), lê o `SingletonLock` do Chrome (symlink com formato `hostname-PID`), extrai o PID e mata o processo. Essencial para a rota `terminateInactive` funcionar corretamente.

## Fluxo de Recovery (RECOVER_SESSIONS=TRUE)

```
Página fecha/erro
    → safeRestartSession()
        → canRestart()? (máx 3 tentativas em 2min)
            → Sim: acquireLock → destroy → kill → wait 2s → setupSession → releaseLock
            → Não: abort, kill processo, limpa estado
```

## Histórico de Modificações Recentes

- Para detalhes sobre a correção de sessões Chrome infinitas, veja: `../23022026_fix_sessoes_chrome_infinitas.md`
