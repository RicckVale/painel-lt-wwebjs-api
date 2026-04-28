# Implementação: marcador por instância e encerramento de Chrome órfão

**Data:** 09/04/2026  
**Tipo:** `implementacao_` — identificação de processos Puppeteer / Chrome  

## Contexto

Ao reiniciar o Node sem `SIGTERM` gracioso (ou em falhas), processos filhos do Chrome podem permanecer ativos e acumular CPU/RAM. É necessário correlacionar cada browser a esta aplicação e limpar resíduos na subida.

## Comportamento

1. **Perfil por sessão:** `puppeteer.userDataDir = <SESSIONS_PATH>/.chrome-profiles/<sessionId>` (absoluto), isolado do diretório `session-<id>` do LocalAuth (tokens WhatsApp).
2. **Flag na linha de comando:** `--wwebjs-app-marker=<valor>` onde `<valor>` vem de `WWEBJS_BROWSER_MARKER` ou, se vazio, hash estável derivado do `SESSIONS_PATH` resolvido.
3. **Boot (Linux):** com `CLEANUP_ORPHAN_BROWSERS_ON_STARTUP=true`, percorre `/proc/*/cmdline` e envia `SIGTERM` (depois `SIGKILL` se preciso) a processos cuja linha de comando contém `user-data-dir=<abs>/.chrome-profiles` ou o marcador (este último apenas se parecer Chrome/Chromium).
4. **Shutdown:** handlers `SIGINT` / `SIGTERM` chamam `destroyAllSessions()` antes de `server.close()`.

## Variáveis

| Variável | Efeito |
|----------|--------|
| `WWEBJS_BROWSER_MARKER` | Opcional (legível no `ps`); se vazio, deriva do `SESSIONS_PATH`. Várias instâncias no mesmo servidor: cada uma deve ter **`SESSIONS_PATH` distinto**; a limpeza no boot só encerra processos cujo `user-data-dir` está sob `.chrome-profiles` **dessa** pasta **e** que tragam o marcador só quando coincide com o mesmo prefixo (não mata a outra instância só por marcador igual). |
| `CLEANUP_ORPHAN_BROWSERS_ON_STARTUP` | `false` desativa varredura no boot (ex.: debug). |
| `CHROME_BIN` | Binário do Chrome/Chromium (ex.: stable no servidor). |

## Plataformas

- **Linux:** limpeza automática suportada. Processos antigos **sem** `.chrome-profiles` nem marcador não são afetados (eliminar uma vez manualmente se necessário).
- **Windows / macOS:** limpeza por `/proc` não aplicável; usar parada de sessões pela API ou encerramento manual.

## Histórico de Modificações Recentes

- Registro inicial desta implementação.
- Ajuste: limpeza por marcador exige também o prefixo `user-data-dir` sob o `SESSIONS_PATH` da instância, permitindo o mesmo `WWEBJS_BROWSER_MARKER` em várias instâncias com pastas de sessão diferentes.
